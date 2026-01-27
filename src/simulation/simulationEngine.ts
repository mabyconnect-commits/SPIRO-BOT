/**
 * Simulation Engine - Multi-strategy simulation for every discovered token
 *
 * Runs simulated trades using multiple strategies on every scanned token.
 * Tracks entry/exit/ROI/drawdown/time held/win rate.
 * Marks 5x, 10x, 100x tokens as successful patterns.
 * Feeds results into LearningEngine and MLStrategyEngine.
 */

import { AnalysisResult, TradePosition, TokenData } from '../types';
import { config, TRADING_PRESETS } from '../config';
import { mlEngine, TradeRecord } from '../ml/mlStrategyEngine';
import db from '../database';
import logger from '../utils/logger';
import crypto from 'crypto';

// ============================================================
// TYPES
// ============================================================

export interface SimulationStrategy {
  id: string;
  name: string;
  description: string;
  entryCondition: (analysis: AnalysisResult) => boolean;
  exitCondition: (sim: ActiveSimulation) => { shouldExit: boolean; reason: string };
  positionSizePct: number;   // % of virtual balance
  maxHoldMinutes: number;
  stopLossPct: number;
  takeProfitTiers: number[]; // e.g. [200, 500, 900] for 2x, 5x, 10x
  partialExitPcts: number[]; // % to sell at each tier
}

export interface ActiveSimulation {
  id: string;
  strategyId: string;
  contractAddress: string;
  symbol: string;
  entryPrice: number;
  currentPrice: number;
  highestPrice: number;
  lowestPrice: number;
  entryTime: number;
  lastUpdateTime: number;
  roi: number;
  maxDrawdown: number;
  profitMultiple: number;
  solInvested: number;
  remainingPositionPct: number;
  partialExitsDone: number;
  status: 'active' | 'closed';
  exitReason?: string;
  analysisSnapshot: AnalysisResult;
}

export interface SimulationResult {
  id: string;
  strategyId: string;
  strategyName: string;
  contractAddress: string;
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  roi: number;
  maxDrawdown: number;
  timeHeldMinutes: number;
  outcome: 'win' | 'loss';
  profitMultiple: number;
  is5x: boolean;
  is10x: boolean;
  is100x: boolean;
  exitReason: string;
  timestamp: number;
}

// ============================================================
// BUILT-IN STRATEGIES
// ============================================================

const SIMULATION_STRATEGIES: SimulationStrategy[] = [
  {
    id: 'scalping',
    name: 'Scalping',
    description: 'Quick in-and-out on momentum',
    entryCondition: (a) => a.technical.priceAction === 'bullish' && a.technical.rsi < 70,
    exitCondition: (sim) => {
      if (sim.roi >= 30) return { shouldExit: true, reason: 'Scalp target hit (30%)' };
      if (sim.roi <= -10) return { shouldExit: true, reason: 'Scalp stop loss (-10%)' };
      if (Date.now() - sim.entryTime > 15 * 60000) return { shouldExit: true, reason: 'Scalp time limit (15m)' };
      return { shouldExit: false, reason: '' };
    },
    positionSizePct: 5,
    maxHoldMinutes: 15,
    stopLossPct: 10,
    takeProfitTiers: [30],
    partialExitPcts: [100],
  },
  {
    id: 'momentum',
    name: 'Momentum',
    description: 'Ride strong momentum with trailing stops',
    entryCondition: (a) =>
      a.technical.priceAction === 'bullish' &&
      a.technical.volumeBreakout &&
      a.overallScore >= 50,
    exitCondition: (sim) => {
      const trailStop = sim.highestPrice * 0.7; // 30% trailing
      if (sim.currentPrice <= trailStop && sim.roi > 20) return { shouldExit: true, reason: 'Trailing stop hit' };
      if (sim.roi <= -25) return { shouldExit: true, reason: 'Momentum stop loss (-25%)' };
      if (Date.now() - sim.entryTime > 120 * 60000) return { shouldExit: true, reason: 'Momentum time limit (2h)' };
      return { shouldExit: false, reason: '' };
    },
    positionSizePct: 8,
    maxHoldMinutes: 120,
    stopLossPct: 25,
    takeProfitTiers: [100, 400, 900],
    partialExitPcts: [30, 30, 40],
  },
  {
    id: 'breakout',
    name: 'Breakout',
    description: 'Enter on volume breakout, hold for big moves',
    entryCondition: (a) =>
      a.technical.volumeBreakout &&
      a.fundamental.liquidityLocked &&
      a.overallScore >= 55,
    exitCondition: (sim) => {
      if (sim.roi <= -30) return { shouldExit: true, reason: 'Breakout stop loss (-30%)' };
      if (sim.roi >= 50 && sim.currentPrice < sim.highestPrice * 0.6)
        return { shouldExit: true, reason: 'Breakout reversal detected' };
      if (Date.now() - sim.entryTime > 360 * 60000) return { shouldExit: true, reason: 'Breakout time limit (6h)' };
      return { shouldExit: false, reason: '' };
    },
    positionSizePct: 10,
    maxHoldMinutes: 360,
    stopLossPct: 30,
    takeProfitTiers: [200, 500, 900, 9900],
    partialExitPcts: [20, 20, 30, 30],
  },
  {
    id: 'volume_spike',
    name: 'Volume Spike',
    description: 'Enter on abnormal volume, quick exit',
    entryCondition: (a) =>
      a.token.volume24h > a.token.liquidity * 3 &&
      a.technical.priceAction !== 'bearish',
    exitCondition: (sim) => {
      if (sim.roi >= 50) return { shouldExit: true, reason: 'Volume spike target (50%)' };
      if (sim.roi <= -15) return { shouldExit: true, reason: 'Volume spike stop (-15%)' };
      if (Date.now() - sim.entryTime > 30 * 60000) return { shouldExit: true, reason: 'Volume spike time limit (30m)' };
      return { shouldExit: false, reason: '' };
    },
    positionSizePct: 6,
    maxHoldMinutes: 30,
    stopLossPct: 15,
    takeProfitTiers: [50],
    partialExitPcts: [100],
  },
  {
    id: 'holder_growth',
    name: 'Holder Growth',
    description: 'Enter on rapid holder increase, hold longer',
    entryCondition: (a) =>
      a.fundamental.uniqueHolders >= 200 &&
      !a.fundamental.holderConcentration &&
      a.overallScore >= 45,
    exitCondition: (sim) => {
      if (sim.roi <= -20) return { shouldExit: true, reason: 'Holder growth stop (-20%)' };
      if (Date.now() - sim.entryTime > 480 * 60000) return { shouldExit: true, reason: 'Holder growth time limit (8h)' };
      const trailStop = sim.highestPrice * 0.65;
      if (sim.roi > 100 && sim.currentPrice <= trailStop) return { shouldExit: true, reason: 'Trailing stop after 2x' };
      return { shouldExit: false, reason: '' };
    },
    positionSizePct: 7,
    maxHoldMinutes: 480,
    stopLossPct: 20,
    takeProfitTiers: [200, 900, 4900],
    partialExitPcts: [25, 35, 40],
  },
  {
    id: 'liquidity_inflow',
    name: 'Liquidity Inflow',
    description: 'Enter when liquidity is growing rapidly',
    entryCondition: (a) =>
      a.technical.liquidityScore >= 0.7 &&
      a.fundamental.liquidityLocked &&
      a.token.liquidity >= 50000,
    exitCondition: (sim) => {
      if (sim.roi <= -20) return { shouldExit: true, reason: 'Liquidity inflow stop (-20%)' };
      if (Date.now() - sim.entryTime > 240 * 60000) return { shouldExit: true, reason: 'Liquidity time limit (4h)' };
      return { shouldExit: false, reason: '' };
    },
    positionSizePct: 8,
    maxHoldMinutes: 240,
    stopLossPct: 20,
    takeProfitTiers: [150, 400, 900],
    partialExitPcts: [30, 30, 40],
  },
];

// ============================================================
// SIMULATION ENGINE
// ============================================================

export class SimulationEngine {
  private activeSimulations: Map<string, ActiveSimulation> = new Map();
  private completedResults: SimulationResult[] = [];
  private strategies: SimulationStrategy[] = [...SIMULATION_STRATEGIES];
  private monitorInterval: NodeJS.Timeout | null = null;
  private virtualBalance: number = 1000; // 1000 SOL virtual balance for sims

  private stats = {
    totalSimulations: 0,
    activeSimulations: 0,
    completedSimulations: 0,
    winners: 0,
    losers: 0,
    fiveXCount: 0,
    tenXCount: 0,
    hundredXCount: 0,
    avgROI: 0,
    bestROI: 0,
    worstROI: 0,
  };

  constructor() {
    this.loadCompletedResults();
    logger.info(`SimulationEngine initialized with ${this.strategies.length} strategies`);
  }

  // ============================================================
  // CORE: Simulate token with all strategies
  // ============================================================

  /**
   * Run all applicable strategies on a discovered token
   */
  async simulateToken(analysis: AnalysisResult): Promise<ActiveSimulation[]> {
    const created: ActiveSimulation[] = [];

    for (const strategy of this.strategies) {
      try {
        if (strategy.entryCondition(analysis)) {
          const sim = this.createSimulation(strategy, analysis);
          this.activeSimulations.set(sim.id, sim);
          created.push(sim);
          this.stats.totalSimulations++;
          this.stats.activeSimulations++;

          logger.info(
            `🧪 SIM [${strategy.name}] ${analysis.token.symbol}: ` +
            `entry $${analysis.token.price.toFixed(8)} | ${strategy.positionSizePct}% size`
          );
        }
      } catch (error) {
        logger.error(`Simulation error for ${strategy.id}:`, error);
      }
    }

    return created;
  }

  /**
   * Update all active simulations with current price
   */
  async updateSimulations(contractAddress: string, currentPrice: number): Promise<SimulationResult[]> {
    const closed: SimulationResult[] = [];

    for (const [id, sim] of this.activeSimulations) {
      if (sim.contractAddress !== contractAddress) continue;
      if (sim.status !== 'active') continue;

      // Update price
      sim.currentPrice = currentPrice;
      sim.lastUpdateTime = Date.now();
      sim.highestPrice = Math.max(sim.highestPrice, currentPrice);
      sim.lowestPrice = Math.min(sim.lowestPrice, currentPrice);

      // Calculate ROI and drawdown
      sim.roi = ((currentPrice - sim.entryPrice) / sim.entryPrice) * 100;
      sim.profitMultiple = currentPrice / sim.entryPrice;
      const drawdownFromPeak = ((sim.highestPrice - currentPrice) / sim.highestPrice) * 100;
      sim.maxDrawdown = Math.max(sim.maxDrawdown, drawdownFromPeak);

      // Check partial exits (take profit tiers)
      const strategy = this.strategies.find(s => s.id === sim.strategyId);
      if (strategy) {
        this.checkPartialExits(sim, strategy);

        // Check exit condition
        const exit = strategy.exitCondition(sim);
        if (exit.shouldExit) {
          const result = this.closeSimulation(sim, exit.reason);
          closed.push(result);
        }
      }
    }

    return closed;
  }

  /**
   * Force-close expired simulations
   */
  closeExpiredSimulations(): SimulationResult[] {
    const closed: SimulationResult[] = [];
    const now = Date.now();

    for (const [id, sim] of this.activeSimulations) {
      if (sim.status !== 'active') continue;

      const strategy = this.strategies.find(s => s.id === sim.strategyId);
      const maxHoldMs = (strategy?.maxHoldMinutes || 480) * 60000;

      if (now - sim.entryTime > maxHoldMs) {
        const result = this.closeSimulation(sim, 'Max hold time exceeded');
        closed.push(result);
      }
    }

    return closed;
  }

  // ============================================================
  // SIMULATION MANAGEMENT
  // ============================================================

  private createSimulation(strategy: SimulationStrategy, analysis: AnalysisResult): ActiveSimulation {
    const solAmount = this.virtualBalance * (strategy.positionSizePct / 100);

    return {
      id: `sim_${crypto.randomUUID()}`,
      strategyId: strategy.id,
      contractAddress: analysis.token.contractAddress,
      symbol: analysis.token.symbol,
      entryPrice: analysis.token.price,
      currentPrice: analysis.token.price,
      highestPrice: analysis.token.price,
      lowestPrice: analysis.token.price,
      entryTime: Date.now(),
      lastUpdateTime: Date.now(),
      roi: 0,
      maxDrawdown: 0,
      profitMultiple: 1,
      solInvested: solAmount,
      remainingPositionPct: 100,
      partialExitsDone: 0,
      status: 'active',
      analysisSnapshot: analysis,
    };
  }

  private checkPartialExits(sim: ActiveSimulation, strategy: SimulationStrategy): void {
    const tiers = strategy.takeProfitTiers;
    const exitPcts = strategy.partialExitPcts;

    while (sim.partialExitsDone < tiers.length) {
      const tierIdx = sim.partialExitsDone;
      const tierTarget = tiers[tierIdx];

      if (sim.roi >= tierTarget) {
        const exitPct = exitPcts[tierIdx];
        sim.remainingPositionPct -= exitPct;
        sim.partialExitsDone++;

        const multiple = (tierTarget / 100 + 1).toFixed(0);
        logger.info(
          `🎯 SIM [${strategy.name}] ${sim.symbol}: ` +
          `Partial exit ${exitPct}% at ${multiple}x (${tierTarget}% ROI)`
        );
      } else {
        break;
      }
    }

    // Close if fully exited through partials
    if (sim.remainingPositionPct <= 0) {
      this.closeSimulation(sim, 'All take profit tiers hit');
    }
  }

  private closeSimulation(sim: ActiveSimulation, reason: string): SimulationResult {
    sim.status = 'closed';
    sim.exitReason = reason;

    const timeHeldMinutes = (Date.now() - sim.entryTime) / 60000;
    const is5x = sim.profitMultiple >= 5;
    const is10x = sim.profitMultiple >= 10;
    const is100x = sim.profitMultiple >= 100;

    const result: SimulationResult = {
      id: sim.id,
      strategyId: sim.strategyId,
      strategyName: this.strategies.find(s => s.id === sim.strategyId)?.name || sim.strategyId,
      contractAddress: sim.contractAddress,
      symbol: sim.symbol,
      entryPrice: sim.entryPrice,
      exitPrice: sim.currentPrice,
      roi: sim.roi,
      maxDrawdown: sim.maxDrawdown,
      timeHeldMinutes,
      outcome: sim.roi > 0 ? 'win' : 'loss',
      profitMultiple: sim.profitMultiple,
      is5x,
      is10x,
      is100x,
      exitReason: reason,
      timestamp: Date.now(),
    };

    // Update stats
    this.stats.activeSimulations--;
    this.stats.completedSimulations++;
    if (result.outcome === 'win') this.stats.winners++;
    else this.stats.losers++;
    if (is5x) this.stats.fiveXCount++;
    if (is10x) this.stats.tenXCount++;
    if (is100x) this.stats.hundredXCount++;
    if (sim.roi > this.stats.bestROI) this.stats.bestROI = sim.roi;
    if (sim.roi < this.stats.worstROI) this.stats.worstROI = sim.roi;

    // Running average
    const total = this.stats.completedSimulations;
    this.stats.avgROI = ((this.stats.avgROI * (total - 1)) + sim.roi) / total;

    // Save to completed list and database
    this.completedResults.push(result);
    this.persistSimulationResult(result);

    // Remove from active
    this.activeSimulations.delete(sim.id);

    // Feed into ML engine
    this.feedMLEngine(sim, result);

    const emoji = is100x ? '🚀🚀🚀' : is10x ? '🚀🚀' : is5x ? '🚀' : result.outcome === 'win' ? '✅' : '❌';
    logger.info(
      `${emoji} SIM CLOSED [${result.strategyName}] ${sim.symbol}: ` +
      `${sim.roi.toFixed(1)}% ROI (${sim.profitMultiple.toFixed(1)}x) | ` +
      `${timeHeldMinutes.toFixed(0)}m | ${reason}`
    );

    return result;
  }

  private feedMLEngine(sim: ActiveSimulation, result: SimulationResult): void {
    try {
      const tradeRecord: TradeRecord = {
        id: result.id,
        features: mlEngine.extractFeatures(sim.analysisSnapshot),
        entryPrice: result.entryPrice,
        exitPrice: result.exitPrice,
        roi: result.roi,
        maxDrawdown: result.maxDrawdown,
        timeHeldMinutes: result.timeHeldMinutes,
        strategyUsed: result.strategyId,
        outcome: result.outcome,
        profitMultiple: result.profitMultiple,
        timestamp: result.timestamp,
        isReal: false,
      };

      mlEngine.recordTradeOutcome(tradeRecord);
    } catch (error) {
      logger.error('Error feeding ML engine:', error);
    }
  }

  // ============================================================
  // STRATEGY MANAGEMENT
  // ============================================================

  getStrategies(): SimulationStrategy[] {
    return this.strategies;
  }

  addStrategy(strategy: SimulationStrategy): void {
    if (!this.strategies.find(s => s.id === strategy.id)) {
      this.strategies.push(strategy);
      logger.info(`Strategy "${strategy.name}" added to simulation engine`);
    }
  }

  removeStrategy(strategyId: string): boolean {
    const idx = this.strategies.findIndex(s => s.id === strategyId);
    if (idx !== -1) {
      this.strategies.splice(idx, 1);
      return true;
    }
    return false;
  }

  // ============================================================
  // MONITORING
  // ============================================================

  startMonitoring(intervalMs: number = 60000): void {
    if (this.monitorInterval) return;
    this.monitorInterval = setInterval(() => {
      this.closeExpiredSimulations();
    }, intervalMs);
    logger.info('Simulation monitoring started');
  }

  stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  // ============================================================
  // STATS & REPORTS
  // ============================================================

  getStats() {
    return { ...this.stats };
  }

  getActiveSimulations(): ActiveSimulation[] {
    return Array.from(this.activeSimulations.values()).filter(s => s.status === 'active');
  }

  getCompletedResults(limit: number = 100): SimulationResult[] {
    return this.completedResults.slice(-limit);
  }

  getResultsByStrategy(strategyId: string): SimulationResult[] {
    return this.completedResults.filter(r => r.strategyId === strategyId);
  }

  getSuccessfulPatterns(minMultiple: number = 5): SimulationResult[] {
    return this.completedResults.filter(r => r.profitMultiple >= minMultiple);
  }

  generateReport(): string {
    let report = `🧪 *Simulation Engine Report*\n\n`;
    report += `📊 *Overall Stats*\n`;
    report += `• Total: ${this.stats.totalSimulations}\n`;
    report += `• Active: ${this.stats.activeSimulations}\n`;
    report += `• Completed: ${this.stats.completedSimulations}\n`;
    report += `• Win Rate: ${this.stats.completedSimulations > 0 ? ((this.stats.winners / this.stats.completedSimulations) * 100).toFixed(1) : 0}%\n`;
    report += `• Avg ROI: ${this.stats.avgROI.toFixed(1)}%\n`;
    report += `• Best: ${this.stats.bestROI.toFixed(1)}% | Worst: ${this.stats.worstROI.toFixed(1)}%\n\n`;

    report += `🏆 *Multiplier Hits*\n`;
    report += `• 5x+: ${this.stats.fiveXCount}\n`;
    report += `• 10x+: ${this.stats.tenXCount}\n`;
    report += `• 100x+: ${this.stats.hundredXCount}\n\n`;

    report += `📈 *Per-Strategy Performance*\n`;
    for (const strategy of this.strategies) {
      const results = this.getResultsByStrategy(strategy.id);
      if (results.length === 0) continue;
      const wins = results.filter(r => r.outcome === 'win').length;
      const avgROI = results.reduce((s, r) => s + r.roi, 0) / results.length;
      report += `• *${strategy.name}*: ${results.length} trades, ${((wins / results.length) * 100).toFixed(0)}% WR, ${avgROI.toFixed(1)}% avg ROI\n`;
    }

    return report;
  }

  // ============================================================
  // PERSISTENCE
  // ============================================================

  private persistSimulationResult(result: SimulationResult): void {
    try {
      (db as any).db?.exec(`
        CREATE TABLE IF NOT EXISTS simulation_results (
          id TEXT PRIMARY KEY,
          strategy_id TEXT,
          strategy_name TEXT,
          contract_address TEXT,
          symbol TEXT,
          entry_price REAL,
          exit_price REAL,
          roi REAL,
          max_drawdown REAL,
          time_held_minutes REAL,
          outcome TEXT,
          profit_multiple REAL,
          is_5x INTEGER,
          is_10x INTEGER,
          is_100x INTEGER,
          exit_reason TEXT,
          timestamp INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      (db as any).db?.prepare(`
        INSERT OR REPLACE INTO simulation_results
        (id, strategy_id, strategy_name, contract_address, symbol, entry_price, exit_price,
         roi, max_drawdown, time_held_minutes, outcome, profit_multiple,
         is_5x, is_10x, is_100x, exit_reason, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        result.id, result.strategyId, result.strategyName,
        result.contractAddress, result.symbol,
        result.entryPrice, result.exitPrice,
        result.roi, result.maxDrawdown, result.timeHeldMinutes,
        result.outcome, result.profitMultiple,
        result.is5x ? 1 : 0, result.is10x ? 1 : 0, result.is100x ? 1 : 0,
        result.exitReason, result.timestamp
      );
    } catch (error) {
      logger.error('Error persisting simulation result:', error);
    }
  }

  private loadCompletedResults(): void {
    try {
      (db as any).db?.exec(`
        CREATE TABLE IF NOT EXISTS simulation_results (
          id TEXT PRIMARY KEY,
          strategy_id TEXT,
          strategy_name TEXT,
          contract_address TEXT,
          symbol TEXT,
          entry_price REAL,
          exit_price REAL,
          roi REAL,
          max_drawdown REAL,
          time_held_minutes REAL,
          outcome TEXT,
          profit_multiple REAL,
          is_5x INTEGER,
          is_10x INTEGER,
          is_100x INTEGER,
          exit_reason TEXT,
          timestamp INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      const rows = (db as any).db?.prepare(
        `SELECT * FROM simulation_results ORDER BY timestamp DESC LIMIT 5000`
      ).all() || [];

      this.completedResults = rows.map((r: any) => ({
        id: r.id,
        strategyId: r.strategy_id,
        strategyName: r.strategy_name,
        contractAddress: r.contract_address,
        symbol: r.symbol,
        entryPrice: r.entry_price,
        exitPrice: r.exit_price,
        roi: r.roi,
        maxDrawdown: r.max_drawdown,
        timeHeldMinutes: r.time_held_minutes,
        outcome: r.outcome,
        profitMultiple: r.profit_multiple,
        is5x: r.is_5x === 1,
        is10x: r.is_10x === 1,
        is100x: r.is_100x === 1,
        exitReason: r.exit_reason,
        timestamp: r.timestamp,
      }));

      // Rebuild stats
      for (const r of this.completedResults) {
        this.stats.completedSimulations++;
        this.stats.totalSimulations++;
        if (r.outcome === 'win') this.stats.winners++;
        else this.stats.losers++;
        if (r.is5x) this.stats.fiveXCount++;
        if (r.is10x) this.stats.tenXCount++;
        if (r.is100x) this.stats.hundredXCount++;
      }
      if (this.stats.completedSimulations > 0) {
        this.stats.avgROI = this.completedResults.reduce((s, r) => s + r.roi, 0) / this.stats.completedSimulations;
        this.stats.bestROI = Math.max(...this.completedResults.map(r => r.roi), 0);
        this.stats.worstROI = Math.min(...this.completedResults.map(r => r.roi), 0);
      }

      logger.info(`Loaded ${this.completedResults.length} historical simulation results`);
    } catch (error) {
      logger.error('Error loading simulation results:', error);
    }
  }
}

export const simulationEngine = new SimulationEngine();
export default simulationEngine;
