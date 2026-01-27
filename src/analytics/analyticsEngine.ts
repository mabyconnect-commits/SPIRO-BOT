/**
 * Analytics Engine - Comprehensive statistics, leaderboards, and performance tracking
 *
 * Provides:
 * - Overall trading statistics (sim + real)
 * - Strategy performance comparisons
 * - Simulation vs real trade comparison
 * - Leaderboard rankings
 * - Profit/loss tracking
 * - Win streak / loss streak analysis
 * - Token success rate analytics
 * - ML accuracy tracking
 * - Time-based performance analysis
 */

import { TradePosition } from '../types';
import { mlEngine } from '../ml/mlStrategyEngine';
import { simulationEngine } from '../simulation/simulationEngine';
import { strategyEngine } from '../strategy/strategyEngine';
import { riskManager } from '../risk/riskManager';
import db from '../database';
import logger from '../utils/logger';

// ============================================================
// TYPES
// ============================================================

export interface TradingStats {
  totalTrades: number;
  simTrades: number;
  realTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalROI: number;
  avgROI: number;
  bestTrade: { symbol: string; roi: number } | null;
  worstTrade: { symbol: string; roi: number } | null;
  totalPnLSol: number;
  currentStreak: { type: 'win' | 'loss'; count: number };
  longestWinStreak: number;
  longestLossStreak: number;
  fiveXCount: number;
  tenXCount: number;
  hundredXCount: number;
  avgHoldTimeMinutes: number;
  profitFactor: number;
}

export interface LeaderboardEntry {
  userId: number;
  username: string;
  totalROI: number;
  winRate: number;
  totalTrades: number;
  totalPnLSol: number;
  bestMultiple: number;
  rank: number;
}

export interface SimVsRealComparison {
  simWinRate: number;
  realWinRate: number;
  simAvgROI: number;
  realAvgROI: number;
  simTrades: number;
  realTrades: number;
  simPnL: number;
  realPnL: number;
  correlation: number;
}

export interface StrategyAnalytics {
  strategyId: string;
  strategyName: string;
  trades: number;
  winRate: number;
  avgROI: number;
  sharpe: number;
  maxDrawdown: number;
  profitFactor: number;
  bestTrade: number;
  worstTrade: number;
  active: boolean;
}

// ============================================================
// ANALYTICS ENGINE
// ============================================================

export class AnalyticsEngine {
  constructor() {
    logger.info('AnalyticsEngine initialized');
  }

  // ============================================================
  // OVERALL STATS
  // ============================================================

  getUserStats(userId: number): TradingStats {
    const allPositions = this.getAllUserPositions(userId);
    const closedPositions = allPositions.filter(p => p.status === 'closed');

    if (closedPositions.length === 0) {
      return this.emptyStats();
    }

    const wins = closedPositions.filter(p => p.pnlPercentage > 0);
    const losses = closedPositions.filter(p => p.pnlPercentage <= 0);
    const simTrades = closedPositions.filter(p => p.type === 'paper');
    const realTrades = closedPositions.filter(p => p.type === 'real');

    const totalPnL = closedPositions.reduce((s, p) => s + p.pnl, 0);
    const avgROI = closedPositions.reduce((s, p) => s + p.pnlPercentage, 0) / closedPositions.length;
    const totalROI = closedPositions.reduce((s, p) => s + p.pnlPercentage, 0);

    // Best and worst
    const sorted = [...closedPositions].sort((a, b) => b.pnlPercentage - a.pnlPercentage);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];

    // Streaks
    const streaks = this.calculateStreaks(closedPositions);

    // Multiplier counts
    const fiveX = closedPositions.filter(p => p.pnlPercentage >= 400).length;
    const tenX = closedPositions.filter(p => p.pnlPercentage >= 900).length;
    const hundredX = closedPositions.filter(p => p.pnlPercentage >= 9900).length;

    // Hold time
    const holdTimes = closedPositions
      .filter(p => p.closedAt && p.openedAt)
      .map(p => (new Date(p.closedAt!).getTime() - new Date(p.openedAt).getTime()) / 60000);
    const avgHoldTime = holdTimes.length > 0 ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length : 0;

    // Profit factor
    const grossProfit = wins.reduce((s, p) => s + Math.abs(p.pnl), 0);
    const grossLoss = losses.reduce((s, p) => s + Math.abs(p.pnl), 0) || 1;

    return {
      totalTrades: closedPositions.length,
      simTrades: simTrades.length,
      realTrades: realTrades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: wins.length / closedPositions.length,
      totalROI,
      avgROI,
      bestTrade: best ? { symbol: best.symbol, roi: best.pnlPercentage } : null,
      worstTrade: worst ? { symbol: worst.symbol, roi: worst.pnlPercentage } : null,
      totalPnLSol: totalPnL,
      currentStreak: streaks.current,
      longestWinStreak: streaks.longestWin,
      longestLossStreak: streaks.longestLoss,
      fiveXCount: fiveX,
      tenXCount: tenX,
      hundredXCount: hundredX,
      avgHoldTimeMinutes: avgHoldTime,
      profitFactor: grossProfit / grossLoss,
    };
  }

  // ============================================================
  // SIMULATION VS REAL COMPARISON
  // ============================================================

  getSimVsRealComparison(userId: number): SimVsRealComparison {
    const allPositions = this.getAllUserPositions(userId).filter(p => p.status === 'closed');
    const sim = allPositions.filter(p => p.type === 'paper');
    const real = allPositions.filter(p => p.type === 'real');

    const simWins = sim.filter(p => p.pnlPercentage > 0).length;
    const realWins = real.filter(p => p.pnlPercentage > 0).length;

    return {
      simWinRate: sim.length > 0 ? simWins / sim.length : 0,
      realWinRate: real.length > 0 ? realWins / real.length : 0,
      simAvgROI: sim.length > 0 ? sim.reduce((s, p) => s + p.pnlPercentage, 0) / sim.length : 0,
      realAvgROI: real.length > 0 ? real.reduce((s, p) => s + p.pnlPercentage, 0) / real.length : 0,
      simTrades: sim.length,
      realTrades: real.length,
      simPnL: sim.reduce((s, p) => s + p.pnl, 0),
      realPnL: real.reduce((s, p) => s + p.pnl, 0),
      correlation: this.calculateCorrelation(sim, real),
    };
  }

  // ============================================================
  // STRATEGY ANALYTICS
  // ============================================================

  getStrategyAnalytics(): StrategyAnalytics[] {
    const strategies = strategyEngine.getAllStrategies();
    const simResults = simulationEngine.getCompletedResults(5000);

    return strategies.map(s => {
      const results = simResults.filter(r => r.strategyId === s.id);
      if (results.length === 0) {
        return {
          strategyId: s.id,
          strategyName: s.name,
          trades: 0, winRate: 0, avgROI: 0, sharpe: 0,
          maxDrawdown: 0, profitFactor: 0, bestTrade: 0, worstTrade: 0,
          active: s.enabled,
        };
      }

      const wins = results.filter(r => r.outcome === 'win').length;
      const returns = results.map(r => r.roi);
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length) || 1;
      const grossProfit = returns.filter(r => r > 0).reduce((a, b) => a + b, 0);
      const grossLoss = Math.abs(returns.filter(r => r < 0).reduce((a, b) => a + b, 0)) || 1;

      return {
        strategyId: s.id,
        strategyName: s.name,
        trades: results.length,
        winRate: wins / results.length,
        avgROI: mean,
        sharpe: mean / std,
        maxDrawdown: Math.max(...results.map(r => r.maxDrawdown), 0),
        profitFactor: grossProfit / grossLoss,
        bestTrade: Math.max(...returns),
        worstTrade: Math.min(...returns),
        active: s.enabled,
      };
    }).sort((a, b) => b.winRate - a.winRate);
  }

  // ============================================================
  // LEADERBOARD
  // ============================================================

  getLeaderboard(limit: number = 20): LeaderboardEntry[] {
    try {
      const rows = (db as any).db?.prepare(`
        SELECT
          p.user_id,
          u.telegram_username,
          COUNT(*) as total_trades,
          SUM(CASE WHEN p.pnl > 0 THEN 1 ELSE 0 END) as wins,
          AVG(p.pnl_percentage) as avg_roi,
          SUM(p.pnl_percentage) as total_roi,
          SUM(p.pnl) as total_pnl,
          MAX(p.pnl_percentage) as best_multiple
        FROM positions p
        LEFT JOIN users u ON p.user_id = u.user_id
        WHERE p.status = 'closed'
        GROUP BY p.user_id
        HAVING total_trades >= 3
        ORDER BY total_roi DESC
        LIMIT ?
      `).all(limit) || [];

      return (rows as any[]).map((row, idx) => ({
        userId: row.user_id,
        username: row.telegram_username || `User ${row.user_id}`,
        totalROI: row.total_roi || 0,
        winRate: row.total_trades > 0 ? (row.wins / row.total_trades) : 0,
        totalTrades: row.total_trades,
        totalPnLSol: row.total_pnl || 0,
        bestMultiple: row.best_multiple ? (row.best_multiple / 100 + 1) : 1,
        rank: idx + 1,
      }));
    } catch (error) {
      logger.error('Error getting leaderboard:', error);
      return [];
    }
  }

  // ============================================================
  // ML ACCURACY TRACKING
  // ============================================================

  getMLAccuracyStats(): {
    modelVersion: number;
    accuracy: number;
    totalPredictions: number;
    correctPredictions: number;
    confidenceCalibration: { range: string; predicted: number; actual: number }[];
  } {
    const mlStats = (mlEngine as any).modelState;

    return {
      modelVersion: mlStats.version || 1,
      accuracy: mlStats.accuracy || 0,
      totalPredictions: mlStats.trainingSize || 0,
      correctPredictions: Math.round((mlStats.accuracy || 0) * (mlStats.trainingSize || 0)),
      confidenceCalibration: [
        { range: '0-25%', predicted: 0.125, actual: 0 },
        { range: '25-50%', predicted: 0.375, actual: 0 },
        { range: '50-75%', predicted: 0.625, actual: 0 },
        { range: '75-100%', predicted: 0.875, actual: 0 },
      ],
    };
  }

  // ============================================================
  // TELEGRAM REPORTS
  // ============================================================

  generateStatsReport(userId: number): string {
    const stats = this.getUserStats(userId);

    let report = `📊 *Trading Statistics*\n\n`;

    const roiEmoji = stats.totalPnLSol >= 0 ? '🟢' : '🔴';
    report += `${roiEmoji} *Total PnL*: ${stats.totalPnLSol >= 0 ? '+' : ''}${stats.totalPnLSol.toFixed(4)} SOL\n`;
    report += `📈 *Total ROI*: ${stats.totalROI.toFixed(1)}%\n`;
    report += `🎯 *Win Rate*: ${(stats.winRate * 100).toFixed(1)}% (${stats.wins}W / ${stats.losses}L)\n`;
    report += `📉 *Avg ROI*: ${stats.avgROI.toFixed(1)}%\n`;
    report += `⚖️ *Profit Factor*: ${stats.profitFactor.toFixed(2)}\n\n`;

    report += `📦 *Trade Breakdown*\n`;
    report += `• Total: ${stats.totalTrades}\n`;
    report += `• Simulated: ${stats.simTrades}\n`;
    report += `• Real: ${stats.realTrades}\n`;
    report += `• Avg Hold Time: ${stats.avgHoldTimeMinutes.toFixed(0)} min\n\n`;

    report += `🏆 *Highlights*\n`;
    if (stats.bestTrade) {
      report += `• Best: ${stats.bestTrade.symbol} (+${stats.bestTrade.roi.toFixed(1)}%)\n`;
    }
    if (stats.worstTrade) {
      report += `• Worst: ${stats.worstTrade.symbol} (${stats.worstTrade.roi.toFixed(1)}%)\n`;
    }
    report += `• Current Streak: ${stats.currentStreak.count} ${stats.currentStreak.type === 'win' ? '✅' : '❌'}\n`;
    report += `• Longest Win Streak: ${stats.longestWinStreak}\n\n`;

    report += `🚀 *Big Winners*\n`;
    report += `• 5x+: ${stats.fiveXCount}\n`;
    report += `• 10x+: ${stats.tenXCount}\n`;
    report += `• 100x+: ${stats.hundredXCount}\n`;

    return report;
  }

  generateLeaderboardReport(): string {
    const leaders = this.getLeaderboard(10);

    let report = `🏆 *Leaderboard*\n\n`;

    if (leaders.length === 0) {
      report += `No trades recorded yet. Start trading to appear here!\n`;
      return report;
    }

    leaders.forEach((entry) => {
      const medal = ['🥇', '🥈', '🥉'][entry.rank - 1] || `${entry.rank}.`;
      const roiEmoji = entry.totalROI >= 0 ? '🟢' : '🔴';
      report += `${medal} *${entry.username}*\n`;
      report += `   ${roiEmoji} ROI: ${entry.totalROI.toFixed(1)}% | WR: ${(entry.winRate * 100).toFixed(0)}% | Trades: ${entry.totalTrades}\n`;
      if (entry.bestMultiple > 2) {
        report += `   🚀 Best: ${entry.bestMultiple.toFixed(0)}x\n`;
      }
      report += `\n`;
    });

    return report;
  }

  generateProfitsReport(userId: number): string {
    const stats = this.getUserStats(userId);
    const comparison = this.getSimVsRealComparison(userId);
    const balance = db.getPaperBalance(userId);

    let report = `💰 *Profit Report*\n\n`;

    report += `💼 *Paper Balance*: ${balance.toFixed(4)} SOL\n`;
    report += `📊 *Total PnL*: ${stats.totalPnLSol >= 0 ? '+' : ''}${stats.totalPnLSol.toFixed(4)} SOL\n\n`;

    report += `🧪 *Simulation Performance*\n`;
    report += `• Trades: ${comparison.simTrades}\n`;
    report += `• Win Rate: ${(comparison.simWinRate * 100).toFixed(1)}%\n`;
    report += `• Avg ROI: ${comparison.simAvgROI.toFixed(1)}%\n`;
    report += `• PnL: ${comparison.simPnL >= 0 ? '+' : ''}${comparison.simPnL.toFixed(4)} SOL\n\n`;

    report += `💰 *Real Trading Performance*\n`;
    report += `• Trades: ${comparison.realTrades}\n`;
    report += `• Win Rate: ${(comparison.realWinRate * 100).toFixed(1)}%\n`;
    report += `• Avg ROI: ${comparison.realAvgROI.toFixed(1)}%\n`;
    report += `• PnL: ${comparison.realPnL >= 0 ? '+' : ''}${comparison.realPnL.toFixed(4)} SOL\n`;

    return report;
  }

  generateSimulationReport(): string {
    return simulationEngine.generateReport();
  }

  generateStrategiesReport(): string {
    const analytics = this.getStrategyAnalytics();

    let report = `🤖 *Strategy Performance*\n\n`;

    if (analytics.every(a => a.trades === 0)) {
      report += `No strategy data yet. Strategies will be evaluated as simulations run.\n`;
      return report;
    }

    const active = analytics.filter(a => a.active && a.trades > 0);
    const disabled = analytics.filter(a => !a.active && a.trades > 0);

    if (active.length > 0) {
      report += `✅ *Active Strategies*\n`;
      active.forEach(a => {
        report += `• *${a.strategyName}*: ${(a.winRate * 100).toFixed(0)}% WR, ${a.avgROI.toFixed(1)}% ROI, Sharpe ${a.sharpe.toFixed(2)} (${a.trades} trades)\n`;
      });
      report += `\n`;
    }

    if (disabled.length > 0) {
      report += `❌ *Disabled Strategies*\n`;
      disabled.forEach(a => {
        report += `• *${a.strategyName}*: ${(a.winRate * 100).toFixed(0)}% WR, ${a.avgROI.toFixed(1)}% ROI (${a.trades} trades)\n`;
      });
    }

    return report;
  }

  generateMLReport(): string {
    const mlAccuracy = this.getMLAccuracyStats();
    const mlStats = mlEngine.getMLStats();

    let report = mlStats;
    report += `\n\n🎯 *ML Accuracy*\n`;
    report += `• Model v${mlAccuracy.modelVersion}\n`;
    report += `• Accuracy: ${(mlAccuracy.accuracy * 100).toFixed(1)}%\n`;
    report += `• Predictions: ${mlAccuracy.totalPredictions}\n`;

    return report;
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private getAllUserPositions(userId: number): TradePosition[] {
    try {
      const rows = (db as any).db?.prepare(
        'SELECT * FROM positions WHERE user_id = ? ORDER BY opened_at DESC'
      ).all(userId) || [];

      return (rows as any[]).map(row => ({
        id: row.id,
        userId: row.user_id,
        contractAddress: row.contract_address,
        symbol: row.symbol,
        entryPrice: row.entry_price,
        currentPrice: row.current_price,
        amount: row.amount,
        solInvested: row.sol_invested,
        pnl: row.pnl || 0,
        pnlPercentage: row.pnl_percentage || 0,
        openedAt: new Date(row.opened_at),
        closedAt: row.closed_at ? new Date(row.closed_at) : undefined,
        status: row.status,
        type: row.type,
      }));
    } catch (error) {
      logger.error('Error fetching user positions:', error);
      return [];
    }
  }

  private calculateStreaks(positions: TradePosition[]): {
    current: { type: 'win' | 'loss'; count: number };
    longestWin: number;
    longestLoss: number;
  } {
    let currentType: 'win' | 'loss' = 'win';
    let currentCount = 0;
    let longestWin = 0;
    let longestLoss = 0;
    let winStreak = 0;
    let lossStreak = 0;

    // Oldest first
    const sorted = [...positions].sort((a, b) =>
      new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime()
    );

    for (const p of sorted) {
      const isWin = p.pnlPercentage > 0;
      if (isWin) {
        winStreak++;
        lossStreak = 0;
        longestWin = Math.max(longestWin, winStreak);
      } else {
        lossStreak++;
        winStreak = 0;
        longestLoss = Math.max(longestLoss, lossStreak);
      }
      currentType = isWin ? 'win' : 'loss';
      currentCount = isWin ? winStreak : lossStreak;
    }

    return {
      current: { type: currentType, count: currentCount },
      longestWin,
      longestLoss,
    };
  }

  private calculateCorrelation(sim: TradePosition[], real: TradePosition[]): number {
    if (sim.length < 3 || real.length < 3) return 0;
    // Simplified: compare average ROI correlation
    const simAvg = sim.reduce((s, p) => s + p.pnlPercentage, 0) / sim.length;
    const realAvg = real.reduce((s, p) => s + p.pnlPercentage, 0) / real.length;
    // Return ratio as proxy for correlation
    if (simAvg === 0) return 0;
    return Math.min(1, Math.max(-1, realAvg / simAvg));
  }

  private emptyStats(): TradingStats {
    return {
      totalTrades: 0, simTrades: 0, realTrades: 0,
      wins: 0, losses: 0, winRate: 0,
      totalROI: 0, avgROI: 0,
      bestTrade: null, worstTrade: null,
      totalPnLSol: 0,
      currentStreak: { type: 'win', count: 0 },
      longestWinStreak: 0, longestLossStreak: 0,
      fiveXCount: 0, tenXCount: 0, hundredXCount: 0,
      avgHoldTimeMinutes: 0, profitFactor: 0,
    };
  }
}

export const analyticsEngine = new AnalyticsEngine();
export default analyticsEngine;
