/**
 * Strategy Engine - Unified strategy management with auto-enable/disable
 *
 * Consolidates all strategy logic:
 * - Strategy registry with performance tracking
 * - Auto-enable/disable based on performance metrics
 * - Strategy weights and ranking
 * - Market-condition-based strategy selection (low cap vs high cap)
 * - Custom strategy builder
 * - Continuous evolution from simulation + real trade data
 */

import { AnalysisResult, RunnerPattern, TradingPreset } from '../types';
import { config, TRADING_PRESETS, RUNNER_PATTERNS } from '../config';
import { mlEngine, MLPrediction, StrategyPerformance } from '../ml/mlStrategyEngine';
import { simulationEngine } from '../simulation/simulationEngine';
import db from '../database';
import logger from '../utils/logger';

// ============================================================
// TYPES
// ============================================================

export interface StrategyConfig {
  id: string;
  name: string;
  description: string;
  type: 'low_cap' | 'high_cap' | 'aggressive' | 'conservative' | 'custom';
  enabled: boolean;
  weight: number;
  conditions: StrategyCondition[];
  riskParams: {
    maxPositionSizeSol: number;
    stopLossPct: number;
    takeProfitTiers: number[];
    partialExitPcts: number[];
    trailingStopPct: number;
    maxHoldMinutes: number;
  };
  performance: StrategyMetrics;
}

export interface StrategyCondition {
  field: string;
  operator: 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'between';
  value: number | [number, number];
  weight: number;
}

export interface StrategyMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgROI: number;
  sharpeRatio: number;
  maxDrawdown: number;
  profitFactor: number;
  fiveXCount: number;
  tenXCount: number;
  hundredXCount: number;
  lastUpdated: number;
}

export interface StrategyRecommendation {
  strategy: StrategyConfig;
  mlPrediction: MLPrediction;
  positionSize: number;
  confidence: number;
  reasoning: string;
}

// ============================================================
// DEFAULT STRATEGIES
// ============================================================

function createDefaultStrategies(): StrategyConfig[] {
  return [
    {
      id: 'low_cap_sniper',
      name: 'Low Cap Sniper',
      description: 'Target tokens under $100K mcap with strong signals',
      type: 'low_cap',
      enabled: true,
      weight: 1.0,
      conditions: [
        { field: 'marketCap', operator: 'lt', value: 100000, weight: 0.3 },
        { field: 'overallScore', operator: 'gte', value: 50, weight: 0.3 },
        { field: 'volumeBreakout', operator: 'eq', value: 1, weight: 0.2 },
        { field: 'liquidityLocked', operator: 'eq', value: 1, weight: 0.2 },
      ],
      riskParams: {
        maxPositionSizeSol: 0.5,
        stopLossPct: 30,
        takeProfitTiers: [200, 500, 900, 9900],
        partialExitPcts: [20, 20, 30, 30],
        trailingStopPct: 30,
        maxHoldMinutes: 480,
      },
      performance: emptyMetrics(),
    },
    {
      id: 'mid_cap_momentum',
      name: 'Mid Cap Momentum',
      description: 'Ride momentum on $100K-$1M tokens',
      type: 'high_cap',
      enabled: true,
      weight: 1.0,
      conditions: [
        { field: 'marketCap', operator: 'between', value: [100000, 1000000], weight: 0.2 },
        { field: 'priceAction', operator: 'eq', value: 1, weight: 0.3 },
        { field: 'volume24h', operator: 'gte', value: 100000, weight: 0.25 },
        { field: 'overallScore', operator: 'gte', value: 60, weight: 0.25 },
      ],
      riskParams: {
        maxPositionSizeSol: 1.0,
        stopLossPct: 25,
        takeProfitTiers: [100, 300, 500],
        partialExitPcts: [30, 30, 40],
        trailingStopPct: 25,
        maxHoldMinutes: 240,
      },
      performance: emptyMetrics(),
    },
    {
      id: 'smart_money_follow',
      name: 'Smart Money Follow',
      description: 'Follow smart money wallet entries',
      type: 'aggressive',
      enabled: true,
      weight: 1.2,
      conditions: [
        { field: 'smartMoneyPresent', operator: 'eq', value: 1, weight: 0.4 },
        { field: 'overallScore', operator: 'gte', value: 55, weight: 0.3 },
        { field: 'liquidityScore', operator: 'gte', value: 0.6, weight: 0.3 },
      ],
      riskParams: {
        maxPositionSizeSol: 2.0,
        stopLossPct: 35,
        takeProfitTiers: [150, 400, 900],
        partialExitPcts: [25, 35, 40],
        trailingStopPct: 30,
        maxHoldMinutes: 360,
      },
      performance: emptyMetrics(),
    },
    {
      id: 'safe_play',
      name: 'Safe Play',
      description: 'High confidence, locked liquidity, low risk',
      type: 'conservative',
      enabled: true,
      weight: 0.8,
      conditions: [
        { field: 'overallScore', operator: 'gte', value: 70, weight: 0.3 },
        { field: 'liquidityLocked', operator: 'eq', value: 1, weight: 0.3 },
        { field: 'devWalletLocked', operator: 'eq', value: 1, weight: 0.2 },
        { field: 'rugSignals', operator: 'lt', value: 0.2, weight: 0.2 },
      ],
      riskParams: {
        maxPositionSizeSol: 0.5,
        stopLossPct: 15,
        takeProfitTiers: [50, 100, 200],
        partialExitPcts: [40, 30, 30],
        trailingStopPct: 20,
        maxHoldMinutes: 120,
      },
      performance: emptyMetrics(),
    },
    {
      id: 'degen_runner',
      name: 'Degen Runner',
      description: 'Max risk for potential moonshots',
      type: 'aggressive',
      enabled: true,
      weight: 0.7,
      conditions: [
        { field: 'marketCap', operator: 'lt', value: 50000, weight: 0.3 },
        { field: 'volumeBreakout', operator: 'eq', value: 1, weight: 0.3 },
        { field: 'overallScore', operator: 'gte', value: 40, weight: 0.2 },
        { field: 'trendingScore', operator: 'gte', value: 0.5, weight: 0.2 },
      ],
      riskParams: {
        maxPositionSizeSol: 3.0,
        stopLossPct: 50,
        takeProfitTiers: [500, 900, 4900, 9900],
        partialExitPcts: [15, 20, 30, 35],
        trailingStopPct: 40,
        maxHoldMinutes: 720,
      },
      performance: emptyMetrics(),
    },
    {
      id: 'volume_alpha',
      name: 'Volume Alpha',
      description: 'Enter on extreme volume with good fundamentals',
      type: 'aggressive',
      enabled: true,
      weight: 1.0,
      conditions: [
        { field: 'volumeBreakout', operator: 'eq', value: 1, weight: 0.35 },
        { field: 'volume24h', operator: 'gte', value: 200000, weight: 0.25 },
        { field: 'liquidityScore', operator: 'gte', value: 0.6, weight: 0.2 },
        { field: 'overallScore', operator: 'gte', value: 50, weight: 0.2 },
      ],
      riskParams: {
        maxPositionSizeSol: 1.5,
        stopLossPct: 25,
        takeProfitTiers: [100, 300, 900],
        partialExitPcts: [30, 30, 40],
        trailingStopPct: 25,
        maxHoldMinutes: 180,
      },
      performance: emptyMetrics(),
    },
  ];
}

function emptyMetrics(): StrategyMetrics {
  return {
    totalTrades: 0, wins: 0, losses: 0, winRate: 0,
    avgROI: 0, sharpeRatio: 0, maxDrawdown: 0, profitFactor: 0,
    fiveXCount: 0, tenXCount: 0, hundredXCount: 0, lastUpdated: Date.now(),
  };
}

// ============================================================
// STRATEGY ENGINE
// ============================================================

export class StrategyEngine {
  private strategies: Map<string, StrategyConfig> = new Map();
  private autoManageEnabled: boolean = true;
  private minTradesForAutoDisable: number = 15;
  private disableWinRateThreshold: number = 0.30;
  private reEnableWinRateThreshold: number = 0.50;
  private evolutionInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.loadStrategies();
    logger.info(`StrategyEngine initialized with ${this.strategies.size} strategies`);
  }

  // ============================================================
  // EVALUATE: Which strategies apply to a token?
  // ============================================================

  evaluateToken(analysis: AnalysisResult): StrategyRecommendation[] {
    const recommendations: StrategyRecommendation[] = [];
    const mlPrediction = mlEngine.predict(analysis);

    for (const [id, strategy] of this.strategies) {
      if (!strategy.enabled) continue;

      const score = this.scoreStrategy(strategy, analysis);
      if (score < 0.4) continue; // Below threshold

      // Adjust position size by ML confidence and RL multiplier
      const mlMultiplier = mlPrediction.confidenceScore / 100;
      const rlMultiplier = mlEngine.getPositionSizeMultiplier(id);
      const positionSize = strategy.riskParams.maxPositionSizeSol * mlMultiplier * rlMultiplier * strategy.weight;

      const confidence = (score * 50) + (mlPrediction.confidenceScore * 0.5);

      recommendations.push({
        strategy,
        mlPrediction,
        positionSize: Math.min(positionSize, strategy.riskParams.maxPositionSizeSol * 2),
        confidence: Math.min(100, confidence),
        reasoning: this.generateReasoning(strategy, analysis, mlPrediction, score),
      });
    }

    // Sort by confidence
    return recommendations.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Get the single best strategy recommendation
   */
  getBestStrategy(analysis: AnalysisResult): StrategyRecommendation | null {
    const recs = this.evaluateToken(analysis);
    return recs.length > 0 ? recs[0] : null;
  }

  // ============================================================
  // SCORING
  // ============================================================

  private scoreStrategy(strategy: StrategyConfig, analysis: AnalysisResult): number {
    let totalWeight = 0;
    let totalScore = 0;

    for (const cond of strategy.conditions) {
      const value = this.extractFieldValue(cond.field, analysis);
      if (value === null) continue;

      totalWeight += cond.weight;
      if (this.evaluateCondition(value, cond.operator, cond.value)) {
        totalScore += cond.weight;
      }
    }

    return totalWeight > 0 ? totalScore / totalWeight : 0;
  }

  private extractFieldValue(field: string, analysis: AnalysisResult): number | null {
    const map: Record<string, () => number> = {
      marketCap: () => analysis.token.marketCap,
      liquidity: () => analysis.token.liquidity,
      volume24h: () => analysis.token.volume24h,
      overallScore: () => analysis.overallScore,
      confidence: () => analysis.confidence * 100,
      volumeBreakout: () => analysis.technical.volumeBreakout ? 1 : 0,
      liquidityScore: () => analysis.technical.liquidityScore,
      liquidityLocked: () => analysis.fundamental.liquidityLocked ? 1 : 0,
      devWalletLocked: () => analysis.fundamental.devWalletLocked ? 1 : 0,
      priceAction: () => analysis.technical.priceAction === 'bullish' ? 1 : 0,
      rugSignals: () => mlEngine.extractFeatures(analysis).rugSignals,
      smartMoneyPresent: () => analysis.walletSignals?.some(w => w.isSmartMoney) ? 1 : 0,
      uniqueHolders: () => analysis.fundamental.uniqueHolders,
      trendingScore: () => analysis.social.trendingScore,
      rsi: () => analysis.technical.rsi,
      volatility: () => analysis.technical.volatility,
    };

    const fn = map[field];
    if (!fn) return null;
    try { return fn(); } catch { return null; }
  }

  private evaluateCondition(value: number, operator: string, target: number | [number, number]): boolean {
    if (operator === 'between' && Array.isArray(target)) {
      return value >= target[0] && value <= target[1];
    }
    const t = target as number;
    switch (operator) {
      case 'gt': return value > t;
      case 'lt': return value < t;
      case 'gte': return value >= t;
      case 'lte': return value <= t;
      case 'eq': return value === t;
      default: return false;
    }
  }

  // ============================================================
  // STRATEGY EVOLUTION
  // ============================================================

  /**
   * Update performance metrics from simulation results
   */
  updatePerformance(): void {
    for (const [id, strategy] of this.strategies) {
      const simResults = simulationEngine.getResultsByStrategy(id);
      // Also count from ML engine's data
      const mlPerf = mlEngine.getTopStrategies().find(s => s.strategyId === id);

      if (simResults.length > 0) {
        const wins = simResults.filter(r => r.outcome === 'win').length;
        const returns = simResults.map(r => r.roi);
        const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
        const stdReturn = Math.sqrt(returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / returns.length) || 1;

        const grossProfit = returns.filter(r => r > 0).reduce((s, r) => s + r, 0);
        const grossLoss = Math.abs(returns.filter(r => r < 0).reduce((s, r) => s + r, 0)) || 1;

        strategy.performance = {
          totalTrades: simResults.length,
          wins,
          losses: simResults.length - wins,
          winRate: wins / simResults.length,
          avgROI: meanReturn,
          sharpeRatio: meanReturn / stdReturn,
          maxDrawdown: Math.max(...simResults.map(r => r.maxDrawdown), 0),
          profitFactor: grossProfit / grossLoss,
          fiveXCount: simResults.filter(r => r.is5x).length,
          tenXCount: simResults.filter(r => r.is10x).length,
          hundredXCount: simResults.filter(r => r.is100x).length,
          lastUpdated: Date.now(),
        };
      }

      // Merge ML performance data if available
      if (mlPerf) {
        strategy.weight = Math.max(0.2, Math.min(3.0,
          (strategy.performance.winRate * 0.4 + (mlPerf.winRate || 0) * 0.6) * 2
        ));
      }
    }

    // Auto-manage
    if (this.autoManageEnabled) {
      this.autoManageStrategies();
    }

    this.saveStrategies();
  }

  /**
   * Auto-enable/disable strategies based on performance
   */
  private autoManageStrategies(): void {
    for (const [id, strategy] of this.strategies) {
      const perf = strategy.performance;
      if (perf.totalTrades < this.minTradesForAutoDisable) continue;

      if (strategy.enabled && perf.winRate < this.disableWinRateThreshold) {
        strategy.enabled = false;
        logger.warn(`⛔ Strategy "${strategy.name}" AUTO-DISABLED: ${(perf.winRate * 100).toFixed(0)}% win rate`);
      }

      if (!strategy.enabled && perf.totalTrades >= 10) {
        // Check recent performance (look at last 10 simulations)
        const recent = simulationEngine.getResultsByStrategy(id).slice(-10);
        const recentWinRate = recent.length > 0
          ? recent.filter(r => r.outcome === 'win').length / recent.length
          : 0;

        if (recentWinRate >= this.reEnableWinRateThreshold) {
          strategy.enabled = true;
          logger.info(`✅ Strategy "${strategy.name}" RE-ENABLED: recent WR ${(recentWinRate * 100).toFixed(0)}%`);
        }
      }
    }
  }

  /**
   * Start periodic strategy evolution
   */
  startEvolution(intervalMs: number = 300000): void {
    if (this.evolutionInterval) return;
    this.evolutionInterval = setInterval(() => {
      this.updatePerformance();
      logger.info('Strategy evolution cycle completed');
    }, intervalMs);
    logger.info('Strategy evolution started (every 5 min)');
  }

  stopEvolution(): void {
    if (this.evolutionInterval) {
      clearInterval(this.evolutionInterval);
      this.evolutionInterval = null;
    }
  }

  // ============================================================
  // CUSTOM STRATEGY BUILDER
  // ============================================================

  createCustomStrategy(
    name: string,
    type: StrategyConfig['type'],
    conditions: StrategyCondition[],
    riskParams: Partial<StrategyConfig['riskParams']>
  ): StrategyConfig {
    const id = `custom_${name.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`;
    const strategy: StrategyConfig = {
      id,
      name,
      description: `Custom strategy: ${name}`,
      type,
      enabled: true,
      weight: 1.0,
      conditions,
      riskParams: {
        maxPositionSizeSol: riskParams.maxPositionSizeSol || 1.0,
        stopLossPct: riskParams.stopLossPct || 25,
        takeProfitTiers: riskParams.takeProfitTiers || [100, 300, 900],
        partialExitPcts: riskParams.partialExitPcts || [30, 30, 40],
        trailingStopPct: riskParams.trailingStopPct || 25,
        maxHoldMinutes: riskParams.maxHoldMinutes || 240,
      },
      performance: emptyMetrics(),
    };

    this.strategies.set(id, strategy);
    this.saveStrategies();
    logger.info(`Custom strategy "${name}" created: ${id}`);
    return strategy;
  }

  // ============================================================
  // ACCESSORS
  // ============================================================

  getStrategy(id: string): StrategyConfig | undefined {
    return this.strategies.get(id);
  }

  getAllStrategies(): StrategyConfig[] {
    return Array.from(this.strategies.values());
  }

  getActiveStrategies(): StrategyConfig[] {
    return this.getAllStrategies().filter(s => s.enabled);
  }

  getDisabledStrategies(): StrategyConfig[] {
    return this.getAllStrategies().filter(s => !s.enabled);
  }

  getRankedStrategies(): StrategyConfig[] {
    return this.getAllStrategies()
      .filter(s => s.performance.totalTrades > 0)
      .sort((a, b) => {
        const scoreA = a.performance.winRate * 0.3 + a.performance.sharpeRatio * 0.3 +
          a.performance.profitFactor * 0.2 + a.weight * 0.2;
        const scoreB = b.performance.winRate * 0.3 + b.performance.sharpeRatio * 0.3 +
          b.performance.profitFactor * 0.2 + b.weight * 0.2;
        return scoreB - scoreA;
      });
  }

  toggleStrategy(id: string): boolean {
    const strategy = this.strategies.get(id);
    if (!strategy) return false;
    strategy.enabled = !strategy.enabled;
    this.saveStrategies();
    logger.info(`Strategy "${strategy.name}" ${strategy.enabled ? 'enabled' : 'disabled'}`);
    return true;
  }

  // ============================================================
  // EXPLANATION
  // ============================================================

  private generateReasoning(
    strategy: StrategyConfig, analysis: AnalysisResult,
    ml: MLPrediction, score: number
  ): string {
    const parts: string[] = [];
    parts.push(`Strategy "${strategy.name}" matched (${(score * 100).toFixed(0)}% conditions met)`);

    if (ml.confidenceScore >= 70) parts.push(`ML confidence: ${ml.confidenceScore}%`);
    if (strategy.performance.totalTrades > 10) {
      parts.push(`Historical: ${(strategy.performance.winRate * 100).toFixed(0)}% WR over ${strategy.performance.totalTrades} trades`);
    }
    if (strategy.performance.fiveXCount > 0) {
      parts.push(`Has produced ${strategy.performance.fiveXCount} 5x+ winners`);
    }

    return parts.join('. ') + '.';
  }

  // ============================================================
  // REPORT
  // ============================================================

  generateReport(): string {
    let report = `🤖 *Strategy Engine Report*\n\n`;
    const ranked = this.getRankedStrategies();
    const active = this.getActiveStrategies();
    const disabled = this.getDisabledStrategies();

    report += `📊 *Overview*\n`;
    report += `• Total: ${this.strategies.size}\n`;
    report += `• Active: ${active.length}\n`;
    report += `• Disabled: ${disabled.length}\n\n`;

    if (ranked.length > 0) {
      report += `🏆 *Ranked by Performance*\n`;
      ranked.slice(0, 8).forEach((s, i) => {
        const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
        const status = s.enabled ? '✅' : '❌';
        report += `${medal} ${status} *${s.name}*\n`;
        report += `   WR: ${(s.performance.winRate * 100).toFixed(0)}% | ROI: ${s.performance.avgROI.toFixed(1)}% | Sharpe: ${s.performance.sharpeRatio.toFixed(2)}\n`;
        report += `   Trades: ${s.performance.totalTrades} | 5x: ${s.performance.fiveXCount} | 10x: ${s.performance.tenXCount}\n`;
        report += `   Weight: ${s.weight.toFixed(2)}x\n\n`;
      });
    }

    return report;
  }

  // ============================================================
  // PERSISTENCE
  // ============================================================

  private loadStrategies(): void {
    // Load defaults
    for (const strat of createDefaultStrategies()) {
      this.strategies.set(strat.id, strat);
    }

    // Load saved state from DB
    try {
      (db as any).db?.exec(`
        CREATE TABLE IF NOT EXISTS strategy_configs (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      const rows = (db as any).db?.prepare('SELECT * FROM strategy_configs').all() || [];
      for (const row of rows) {
        try {
          const saved = JSON.parse((row as any).data);
          // Merge saved performance/weight into default or custom
          if (this.strategies.has(saved.id)) {
            const existing = this.strategies.get(saved.id)!;
            existing.performance = saved.performance || existing.performance;
            existing.weight = saved.weight || existing.weight;
            existing.enabled = saved.enabled !== undefined ? saved.enabled : existing.enabled;
          } else {
            // Custom strategy
            this.strategies.set(saved.id, saved);
          }
        } catch {}
      }
    } catch (error) {
      logger.error('Error loading strategies:', error);
    }
  }

  private saveStrategies(): void {
    try {
      (db as any).db?.exec(`
        CREATE TABLE IF NOT EXISTS strategy_configs (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      const stmt = (db as any).db?.prepare(
        `INSERT OR REPLACE INTO strategy_configs (id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`
      );
      for (const [id, strategy] of this.strategies) {
        stmt?.run(id, JSON.stringify(strategy));
      }
    } catch (error) {
      logger.error('Error saving strategies:', error);
    }
  }
}

export const strategyEngine = new StrategyEngine();
export default strategyEngine;
