/**
 * Pipeline Integration - Wires all modules together into the main bot loop
 *
 * Flow:
 * 1. Scanner discovers token
 * 2. Risk Manager pre-filters (blacklist, liquidity)
 * 3. Strategy Engine evaluates applicable strategies
 * 4. Simulation Engine runs all strategy simulations
 * 5. ML Engine predicts confidence
 * 6. Risk Manager gates real vs simulation trade
 * 7. Trade Executor executes
 * 8. Learning Engine + ML Engine record outcome
 * 9. Analytics Engine updates stats
 * 10. Repeat
 */

import { AnalysisResult } from '../types';
import { simulationEngine } from '../simulation/simulationEngine';
import { strategyEngine } from '../strategy/strategyEngine';
import { riskManager } from '../risk/riskManager';
import { analyticsEngine } from '../analytics/analyticsEngine';
import { mlEngine } from '../ml/mlStrategyEngine';
import tradingEngine from '../trading/tradingEngine';
import patternLearner from '../learning/patternLearner';
import db from '../database';
import logger from '../utils/logger';

// ============================================================
// PIPELINE
// ============================================================

export class PipelineIntegration {
  private alertCallbacks: Array<(msg: string, type: 'opportunity' | 'risk' | 'strategy' | 'learning' | 'profit') => void> = [];

  /**
   * Register callback for pipeline alerts (for Telegram notifications)
   */
  onAlert(callback: (msg: string, type: 'opportunity' | 'risk' | 'strategy' | 'learning' | 'profit') => void): void {
    this.alertCallbacks.push(callback);
  }

  private emitAlert(msg: string, type: 'opportunity' | 'risk' | 'strategy' | 'learning' | 'profit'): void {
    for (const cb of this.alertCallbacks) {
      try { cb(msg, type); } catch {}
    }
  }

  /**
   * Process a newly analyzed token through the full pipeline
   */
  async processToken(analysis: AnalysisResult, userId: number = 0): Promise<{
    simulated: boolean;
    traded: boolean;
    blocked: boolean;
    reason: string;
  }> {
    const symbol = analysis.token.symbol;

    // Step 1: Quick risk check (blacklist, honeypot)
    if (riskManager.isBlacklisted(analysis.token.contractAddress)) {
      logger.info(`⛔ ${symbol} blocked by blacklist`);
      return { simulated: false, traded: false, blocked: true, reason: 'Blacklisted token' };
    }

    // Step 2: Run simulations with all strategies
    const simulations = await simulationEngine.simulateToken(analysis);
    const simulated = simulations.length > 0;

    // Step 3: Get strategy recommendation
    const recommendation = strategyEngine.getBestStrategy(analysis);
    if (!recommendation) {
      logger.info(`${symbol}: No strategy matched`);
      return { simulated, traded: false, blocked: false, reason: 'No strategy match' };
    }

    // Step 4: Full risk assessment
    const userSettings = db.getUserSettings(userId);
    const isRealTrading = userSettings ? !userSettings.paperTrading : false;
    const riskAssessment = riskManager.assessTrade(analysis, userId, recommendation, isRealTrading);

    if (!riskAssessment.allowed) {
      logger.info(`⛔ ${symbol} blocked by risk manager: ${riskAssessment.blockers[0]}`);
      if (riskAssessment.blockers.some(b => b.includes('Honeypot'))) {
        this.emitAlert(`🔴 *Risk Detected*: ${symbol} - ${riskAssessment.blockers[0]}`, 'risk');
      }
      return { simulated, traded: false, blocked: true, reason: riskAssessment.reasoning };
    }

    // Step 5: Determine trade type (real vs paper)
    const paperTrade = riskAssessment.isSimulationOnly || !isRealTrading;
    const positionSize = riskAssessment.adjustedPositionSize;

    // Step 6: Execute trade
    const position = await tradingEngine.buy(analysis, positionSize, userId, paperTrade);
    const traded = position !== null;

    if (traded && position) {
      // Emit opportunity alert
      const conf = recommendation.mlPrediction.confidenceScore;
      this.emitAlert(
        `🟢 *${paperTrade ? 'Sim' : 'Real'} Trade*: ${symbol}\n` +
        `Strategy: ${recommendation.strategy.name}\n` +
        `Confidence: ${conf}% | Size: ${positionSize.toFixed(2)} SOL\n` +
        `Risk: ${riskAssessment.riskScore}/100`,
        'opportunity'
      );

      // Record PnL for daily tracking
      if (!paperTrade) {
        riskManager.recordDailyPnL(userId, 0); // Will be updated on close
      }
    }

    // Log warnings
    if (riskAssessment.warnings.length > 0) {
      logger.warn(`${symbol} warnings: ${riskAssessment.warnings.join(', ')}`);
    }

    return {
      simulated,
      traded,
      blocked: false,
      reason: traded
        ? `Traded via ${recommendation.strategy.name} (${recommendation.confidence.toFixed(0)}% conf)`
        : 'Trade execution failed',
    };
  }

  /**
   * Process a closed position through the learning pipeline
   */
  async processClosedPosition(position: any, userId: number = 0): Promise<void> {
    const pnl = position.pnl || 0;
    const pnlPct = position.pnl_percentage || position.pnlPercentage || 0;
    const symbol = position.symbol;

    // Update daily PnL
    riskManager.recordDailyPnL(userId, pnl);

    // Record in pattern learner
    const patterns = patternLearner.getUpdatedPatterns();
    patternLearner.recordTrade(position, patterns);

    // If 2x+ winner, feed ML engine
    if (pnlPct >= 100) {
      this.emitAlert(
        `💰 *Profit Hit*: ${symbol} at +${pnlPct.toFixed(1)}% (${(pnlPct / 100 + 1).toFixed(0)}x)!`,
        'profit'
      );
    }

    // If big loss, check if we should disable strategy
    if (pnlPct <= -40) {
      this.emitAlert(
        `🔴 *Significant Loss*: ${symbol} at ${pnlPct.toFixed(1)}%`,
        'risk'
      );
    }
  }

  /**
   * Start all background services
   */
  startServices(): void {
    // Start simulation monitoring
    simulationEngine.startMonitoring(60000);

    // Start strategy evolution
    strategyEngine.startEvolution(300000);

    // Periodic ML retraining check
    setInterval(() => {
      try { mlEngine.retrain(); } catch {}
    }, 3600000); // 1 hour

    // Periodic strategy performance update
    setInterval(() => {
      try { strategyEngine.updatePerformance(); } catch {}
    }, 600000); // 10 minutes

    logger.info('Pipeline integration services started');
  }

  /**
   * Stop all background services
   */
  stopServices(): void {
    simulationEngine.stopMonitoring();
    strategyEngine.stopEvolution();
    logger.info('Pipeline integration services stopped');
  }

  /**
   * Get full system status for Telegram display
   */
  getSystemStatus(): string {
    const simStats = simulationEngine.getStats();
    const strategies = strategyEngine.getAllStrategies();
    const activeStrats = strategies.filter(s => s.enabled).length;

    let status = `⚙️ *System Status*\n\n`;
    status += `🧪 *Simulations*: ${simStats.activeSimulations} active, ${simStats.completedSimulations} completed\n`;
    status += `🤖 *Strategies*: ${activeStrats}/${strategies.length} active\n`;
    status += `🧠 *ML Model*: v${(mlEngine as any).modelState?.version || 1}\n`;
    status += `🛡️ *Kill Switch*: ${riskManager.isKillSwitchActive() ? '🔴 ACTIVE' : '🟢 OFF'}\n`;
    status += `📊 *5x/10x/100x*: ${simStats.fiveXCount}/${simStats.tenXCount}/${simStats.hundredXCount}\n`;

    return status;
  }
}

export const pipeline = new PipelineIntegration();
export default pipeline;
