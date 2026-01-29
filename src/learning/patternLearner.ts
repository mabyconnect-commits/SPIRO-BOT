import { RunnerPattern, LearningData, TradePosition } from '../types';
import { config, RUNNER_PATTERNS } from '../config';
import db from '../database';
import logger from '../utils/logger';

// Blacklist thresholds
const BLACKLIST_WIN_RATE_THRESHOLD = 0.30; // Win rate below 30% = blacklist candidate
const BLACKLIST_MIN_SAMPLES = 15; // Need at least 15 trades to blacklist
const BLACKLIST_CONSECUTIVE_LOSSES = 5; // 5 consecutive losses = blacklist
const REDEMPTION_WIN_STREAK = 3; // 3 consecutive wins to redeem from blacklist

// Auto-enable thresholds
const AUTO_ENABLE_WIN_RATE = 0.55; // Win rate above 55% = enable
const AUTO_DISABLE_WIN_RATE = 0.35; // Win rate below 35% = disable
const STRATEGY_WEIGHT_MIN = 0.1;
const STRATEGY_WEIGHT_MAX = 3.0;

export interface PatternStatus {
  patternId: string;
  patternName: string;
  isEnabled: boolean;
  isBlacklisted: boolean;
  blacklistReason?: string;
  weight: number;
  winRate: number;
  avgReturn: number;
  sampleSize: number;
  consecutiveLosses: number;
  consecutiveWins: number;
  lastUpdated: Date;
}

export interface StrategyRanking {
  patternId: string;
  patternName: string;
  rank: number;
  profitability: number; // Total profit %
  winRate: number;
  riskAdjustedReturn: number; // Sharpe-like ratio
  sampleSize: number;
  isActive: boolean;
}

export class PatternLearner {
  private antiDriftThreshold = config.learning.antiDriftThreshold;
  private patternStatuses: Map<string, PatternStatus> = new Map();
  private lastStrategyAdjustment: Date = new Date(0);
  private readonly ADJUSTMENT_COOLDOWN_MS = 3600000; // 1 hour cooldown

  constructor() {
    this.initializePatternStatuses();
  }

  /**
   * Initialize pattern statuses from database or defaults
   */
  private initializePatternStatuses(): void {
    for (const pattern of RUNNER_PATTERNS) {
      const saved = db.getPatternStatus(pattern.id);
      if (saved) {
        this.patternStatuses.set(pattern.id, saved);
      } else {
        this.patternStatuses.set(pattern.id, {
          patternId: pattern.id,
          patternName: pattern.name,
          isEnabled: true,
          isBlacklisted: false,
          weight: 1.0,
          winRate: 0.5,
          avgReturn: 0,
          sampleSize: 0,
          consecutiveLosses: 0,
          consecutiveWins: 0,
          lastUpdated: new Date(),
        });
      }
    }
  }

  /**
   * Learn from a completed trade
   */
  recordTrade(position: TradePosition, matchedPatterns: RunnerPattern[]): void {
    if (!config.learning.enabled) return;

    const outcome: 'win' | 'loss' = position.pnlPercentage > 0 ? 'win' : 'loss';
    const returnPercentage = position.pnlPercentage;

    // Record learning data for each matched pattern
    for (const pattern of matchedPatterns) {
      const learningData: LearningData = {
        patternId: pattern.id,
        tradeId: position.id,
        outcome,
        returnPercentage,
        entrySignals: {
          price: position.entryPrice,
          timestamp: position.openedAt,
          confidence: pattern.confidence,
        },
        timestamp: new Date(),
      };

      db.saveLearningData(learningData);
      logger.info(`Recorded ${outcome} for pattern ${pattern.name}: ${returnPercentage.toFixed(2)}%`);

      // Update pattern status with win/loss streak
      this.updatePatternStreak(pattern.id, outcome);
    }

    // Check for drift and adjust strategies
    this.checkForDrift();
    this.autoAdjustStrategies();
  }

  /**
   * Update consecutive win/loss streak for a pattern
   */
  private updatePatternStreak(patternId: string, outcome: 'win' | 'loss'): void {
    const status = this.patternStatuses.get(patternId);
    if (!status) return;

    if (outcome === 'win') {
      status.consecutiveWins++;
      status.consecutiveLosses = 0;

      // Check for redemption from blacklist
      if (status.isBlacklisted && status.consecutiveWins >= REDEMPTION_WIN_STREAK) {
        this.redeemPattern(patternId);
      }
    } else {
      status.consecutiveLosses++;
      status.consecutiveWins = 0;

      // Check for blacklist due to consecutive losses
      if (status.consecutiveLosses >= BLACKLIST_CONSECUTIVE_LOSSES && !status.isBlacklisted) {
        this.blacklistPattern(patternId, `${BLACKLIST_CONSECUTIVE_LOSSES} consecutive losses`);
      }
    }

    status.lastUpdated = new Date();
    this.patternStatuses.set(patternId, status);
    db.savePatternStatus(status);
  }

  /**
   * Blacklist a consistently losing pattern
   */
  blacklistPattern(patternId: string, reason: string): void {
    const status = this.patternStatuses.get(patternId);
    if (!status) return;

    status.isBlacklisted = true;
    status.isEnabled = false;
    status.blacklistReason = reason;
    status.weight = STRATEGY_WEIGHT_MIN;
    status.lastUpdated = new Date();

    this.patternStatuses.set(patternId, status);
    db.savePatternStatus(status);
    db.saveBlacklistedPattern(patternId, reason);

    logger.warn(`🚫 BLACKLISTED: Pattern "${status.patternName}" - Reason: ${reason}`);
  }

  /**
   * Redeem a pattern from blacklist after recovery
   */
  redeemPattern(patternId: string): void {
    const status = this.patternStatuses.get(patternId);
    if (!status || !status.isBlacklisted) return;

    status.isBlacklisted = false;
    status.isEnabled = true;
    status.blacklistReason = undefined;
    status.weight = 0.5; // Start with reduced weight
    status.lastUpdated = new Date();

    this.patternStatuses.set(patternId, status);
    db.savePatternStatus(status);
    db.removeBlacklistedPattern(patternId);

    logger.info(`✅ REDEEMED: Pattern "${status.patternName}" removed from blacklist after ${REDEMPTION_WIN_STREAK} consecutive wins`);
  }

  /**
   * Get all blacklisted patterns
   */
  getBlacklistedPatterns(): PatternStatus[] {
    return Array.from(this.patternStatuses.values()).filter(p => p.isBlacklisted);
  }

  /**
   * Get all enabled patterns
   */
  getEnabledPatterns(): PatternStatus[] {
    return Array.from(this.patternStatuses.values()).filter(p => p.isEnabled && !p.isBlacklisted);
  }

  /**
   * Auto-adjust strategy weights and enable/disable based on performance
   */
  autoAdjustStrategies(): void {
    // Cooldown check
    const now = new Date();
    if (now.getTime() - this.lastStrategyAdjustment.getTime() < this.ADJUSTMENT_COOLDOWN_MS) {
      return;
    }

    logger.info('🔄 Auto-adjusting strategies based on performance...');

    for (const [patternId, status] of this.patternStatuses) {
      const performance = db.getPatternPerformance(patternId);

      if (performance.sampleSize < 10) continue; // Need enough data

      // Update status with latest performance
      status.winRate = performance.successRate;
      status.avgReturn = performance.avgReturn;
      status.sampleSize = performance.sampleSize;

      // Check for blacklist based on win rate
      if (
        performance.successRate < BLACKLIST_WIN_RATE_THRESHOLD &&
        performance.sampleSize >= BLACKLIST_MIN_SAMPLES &&
        !status.isBlacklisted
      ) {
        this.blacklistPattern(patternId, `Win rate ${(performance.successRate * 100).toFixed(0)}% below threshold`);
        continue;
      }

      // Auto-enable high performers
      if (performance.successRate >= AUTO_ENABLE_WIN_RATE && !status.isEnabled && !status.isBlacklisted) {
        status.isEnabled = true;
        status.weight = Math.min(status.weight * 1.5, STRATEGY_WEIGHT_MAX);
        logger.info(`✅ AUTO-ENABLED: "${status.patternName}" - Win rate: ${(performance.successRate * 100).toFixed(0)}%`);
      }

      // Auto-disable poor performers (but don't blacklist yet)
      if (performance.successRate < AUTO_DISABLE_WIN_RATE && status.isEnabled && performance.sampleSize >= 20) {
        status.isEnabled = false;
        status.weight = Math.max(status.weight * 0.5, STRATEGY_WEIGHT_MIN);
        logger.warn(`⚠️ AUTO-DISABLED: "${status.patternName}" - Win rate: ${(performance.successRate * 100).toFixed(0)}%`);
      }

      // Adjust weights continuously
      this.adjustWeight(status, performance.successRate, performance.avgReturn);

      status.lastUpdated = new Date();
      this.patternStatuses.set(patternId, status);
      db.savePatternStatus(status);
    }

    this.lastStrategyAdjustment = now;
    logger.info('✅ Strategy adjustment complete');
  }

  /**
   * Adjust strategy weight based on performance
   */
  private adjustWeight(status: PatternStatus, winRate: number, avgReturn: number): void {
    // Risk-adjusted return: win rate * avg return
    const riskAdjustedReturn = winRate * avgReturn;

    if (riskAdjustedReturn > 50) {
      // Great performance: increase weight
      status.weight = Math.min(status.weight * 1.1, STRATEGY_WEIGHT_MAX);
    } else if (riskAdjustedReturn > 20) {
      // Good performance: slight increase
      status.weight = Math.min(status.weight * 1.05, STRATEGY_WEIGHT_MAX);
    } else if (riskAdjustedReturn < 0) {
      // Negative performance: decrease weight
      status.weight = Math.max(status.weight * 0.9, STRATEGY_WEIGHT_MIN);
    } else if (riskAdjustedReturn < 10) {
      // Poor performance: slight decrease
      status.weight = Math.max(status.weight * 0.95, STRATEGY_WEIGHT_MIN);
    }
  }

  /**
   * Get strategy rankings by profitability
   */
  getStrategyRankings(): StrategyRanking[] {
    const rankings: StrategyRanking[] = [];

    for (const [patternId, status] of this.patternStatuses) {
      const performance = db.getPatternPerformance(patternId);

      if (performance.sampleSize < 5) continue; // Need minimum data

      // Calculate risk-adjusted return (simplified Sharpe-like ratio)
      const riskAdjustedReturn = performance.successRate * performance.avgReturn;

      // Calculate total profitability
      const profitability = performance.avgReturn * performance.sampleSize;

      rankings.push({
        patternId,
        patternName: status.patternName,
        rank: 0, // Will be set after sorting
        profitability,
        winRate: performance.successRate,
        riskAdjustedReturn,
        sampleSize: performance.sampleSize,
        isActive: status.isEnabled && !status.isBlacklisted,
      });
    }

    // Sort by profitability (descending)
    rankings.sort((a, b) => b.profitability - a.profitability);

    // Assign ranks
    rankings.forEach((r, i) => {
      r.rank = i + 1;
    });

    return rankings;
  }

  /**
   * Get pattern status
   */
  getPatternStatus(patternId: string): PatternStatus | undefined {
    return this.patternStatuses.get(patternId);
  }

  /**
   * Manually enable a pattern
   */
  enablePattern(patternId: string): boolean {
    const status = this.patternStatuses.get(patternId);
    if (!status) return false;

    if (status.isBlacklisted) {
      logger.warn(`Cannot enable blacklisted pattern "${status.patternName}". Remove from blacklist first.`);
      return false;
    }

    status.isEnabled = true;
    status.lastUpdated = new Date();
    this.patternStatuses.set(patternId, status);
    db.savePatternStatus(status);

    logger.info(`✅ Manually enabled pattern "${status.patternName}"`);
    return true;
  }

  /**
   * Manually disable a pattern
   */
  disablePattern(patternId: string): boolean {
    const status = this.patternStatuses.get(patternId);
    if (!status) return false;

    status.isEnabled = false;
    status.lastUpdated = new Date();
    this.patternStatuses.set(patternId, status);
    db.savePatternStatus(status);

    logger.info(`🚫 Manually disabled pattern "${status.patternName}"`);
    return true;
  }

  /**
   * Force remove pattern from blacklist
   */
  forceRemoveFromBlacklist(patternId: string): boolean {
    const status = this.patternStatuses.get(patternId);
    if (!status || !status.isBlacklisted) return false;

    this.redeemPattern(patternId);
    return true;
  }

  /**
   * Get updated pattern with learned performance
   */
  getUpdatedPatterns(): RunnerPattern[] {
    const updatedPatterns: RunnerPattern[] = [];

    for (const pattern of RUNNER_PATTERNS) {
      const performance = db.getPatternPerformance(pattern.id);
      const status = this.patternStatuses.get(pattern.id);

      // Skip blacklisted patterns
      if (status?.isBlacklisted) continue;

      updatedPatterns.push({
        ...pattern,
        successRate: performance.successRate,
        avgReturn: performance.avgReturn,
        sampleSize: performance.sampleSize,
        confidence: this.calculateBayesianConfidence(
          pattern.id,
          performance.successRate,
          performance.sampleSize
        ),
      });
    }

    return updatedPatterns;
  }

  /**
   * Calculate Bayesian confidence with prior beliefs
   */
  private calculateBayesianConfidence(
    patternId: string,
    observedSuccessRate: number,
    sampleSize: number
  ): number {
    // Prior belief: patterns start with 50% confidence (neutral)
    const priorSuccessRate = 0.5;
    const priorSampleSize = 10; // Equivalent to 10 prior observations

    // Bayesian update
    const totalSamples = sampleSize + priorSampleSize;
    const posteriorSuccessRate =
      (observedSuccessRate * sampleSize + priorSuccessRate * priorSampleSize) /
      totalSamples;

    // Confidence increases with more samples
    const confidenceFromSampleSize = Math.min(sampleSize / 100, 0.3);

    // Apply weight multiplier from status
    const status = this.patternStatuses.get(patternId);
    const weightMultiplier = status ? status.weight : 1.0;

    const bayesianConfidence = (posteriorSuccessRate + confidenceFromSampleSize) * weightMultiplier;

    return Math.min(0.95, Math.max(0.3, bayesianConfidence));
  }

  /**
   * Anti-drift mechanism: detect when winning patterns are being ignored
   */
  private checkForDrift(): void {
    const patterns = this.getUpdatedPatterns();

    for (const pattern of patterns) {
      if (pattern.sampleSize < 20) continue; // Need enough data

      // Check if a historically winning pattern hasn't been used recently
      if (pattern.successRate > 0.65) {
        const recentTrades = this.getRecentTradesForPattern(pattern.id, 10);

        if (recentTrades.length < 3) {
          logger.warn(
            `🚨 DRIFT DETECTED: ${pattern.name} has ${(pattern.successRate * 100).toFixed(0)}% win rate ` +
            `but only ${recentTrades.length} trades in last 10 positions. This pattern may be getting ignored!`
          );

          // Boost pattern visibility
          this.boostPatternPriority(pattern.id);
        }
      }

      // Check if a losing pattern is being overused
      if (pattern.successRate < 0.45 && pattern.sampleSize > 20) {
        const recentTrades = this.getRecentTradesForPattern(pattern.id, 10);

        if (recentTrades.length > 5) {
          logger.warn(
            `⚠️ OVERUSE DETECTED: ${pattern.name} has ${(pattern.successRate * 100).toFixed(0)}% win rate ` +
            `but ${recentTrades.length} trades in last 10 positions. Consider reducing reliance on this pattern.`
          );
        }
      }
    }
  }

  private getRecentTradesForPattern(patternId: string, limit: number): LearningData[] {
    return db.getRecentTradesForPattern(patternId, limit);
  }

  private boostPatternPriority(patternId: string): void {
    const status = this.patternStatuses.get(patternId);
    if (!status) return;

    status.weight = Math.min(status.weight * 1.2, STRATEGY_WEIGHT_MAX);
    status.lastUpdated = new Date();
    this.patternStatuses.set(patternId, status);
    db.savePatternStatus(status);

    logger.info(`📈 Boosted priority for pattern ${status.patternName} to prevent drift (new weight: ${status.weight.toFixed(2)})`);
  }

  /**
   * Get pattern recommendations based on current performance
   */
  getPatternRecommendations(): { pattern: RunnerPattern; reason: string }[] {
    const patterns = this.getUpdatedPatterns();
    const recommendations: { pattern: RunnerPattern; reason: string }[] = [];

    for (const pattern of patterns) {
      const status = this.patternStatuses.get(pattern.id);

      if (pattern.sampleSize < 10) {
        recommendations.push({
          pattern,
          reason: `📚 Learning phase (${pattern.sampleSize}/10 trades) - gathering data`,
        });
        continue;
      }

      if (pattern.successRate > 0.7) {
        recommendations.push({
          pattern,
          reason: `🔥 Hot pattern! ${(pattern.successRate * 100).toFixed(0)}% win rate over ${pattern.sampleSize} trades (weight: ${status?.weight.toFixed(2) || '1.0'}x)`,
        });
      } else if (pattern.successRate < 0.4) {
        recommendations.push({
          pattern,
          reason: `❄️ Cold pattern - ${(pattern.successRate * 100).toFixed(0)}% win rate, consider avoiding`,
        });
      }
    }

    return recommendations;
  }

  /**
   * Generate learning report including blacklist info
   */
  generateLearningReport(): string {
    const patterns = this.getUpdatedPatterns();
    const blacklisted = this.getBlacklistedPatterns();
    const rankings = this.getStrategyRankings();

    let report = '📊 **Pattern Learning Report**\n\n';

    // Strategy rankings
    report += '🏆 **Strategy Rankings:**\n';
    rankings.slice(0, 5).forEach((r, i) => {
      const statusEmoji = r.isActive ? '✅' : '⚠️';
      report += `${i + 1}. ${statusEmoji} ${r.patternName}\n`;
      report += `   Win: ${(r.winRate * 100).toFixed(0)}% | Profit: ${r.profitability.toFixed(0)}% | Trades: ${r.sampleSize}\n`;
    });
    report += '\n';

    // Active patterns
    report += '📈 **Active Patterns:**\n';
    patterns.forEach(pattern => {
      if (pattern.sampleSize === 0) return;
      const status = this.patternStatuses.get(pattern.id);
      if (!status?.isEnabled) return;

      report += `**${pattern.name}** (${status.weight.toFixed(1)}x weight)\n`;
      report += `• Trades: ${pattern.sampleSize}\n`;
      report += `• Win Rate: ${(pattern.successRate * 100).toFixed(1)}%\n`;
      report += `• Avg Return: ${pattern.avgReturn.toFixed(1)}%\n`;
      report += `• Confidence: ${(pattern.confidence * 100).toFixed(1)}%\n\n`;
    });

    // Blacklisted patterns
    if (blacklisted.length > 0) {
      report += '🚫 **Blacklisted Patterns:**\n';
      blacklisted.forEach(p => {
        report += `• ${p.patternName}: ${p.blacklistReason}\n`;
      });
      report += '\n';
    }

    return report;
  }

  /**
   * Record a successful trade (2x+ winner) with its analysis
   */
  recordSuccessfulTrade(position: any, analysis: any): void {
    try {
      logger.info(`✅ Recording successful pattern from ${position.symbol}`);

      // Extract winning characteristics
      const winningData = {
        symbol: position.symbol,
        contractAddress: position.contract_address,
        entryPrice: position.entry_price,
        pnlPercentage: position.pnl_percentage,
        overallScore: analysis.overallScore,
        confidence: analysis.confidence,
        recommendation: analysis.recommendation,
        patterns: analysis.matchedPatterns?.map((p: any) => p.name).join(', '),
        technicalScore: analysis.technical,
        fundamentalScore: analysis.fundamental,
        timestamp: new Date().toISOString(),
      };

      // Save to database for future reference
      db.saveSuccessfulPattern(winningData);

      // Boost winning patterns
      if (analysis.matchedPatterns) {
        for (const pattern of analysis.matchedPatterns) {
          const status = this.patternStatuses.get(pattern.id);
          if (status) {
            // Big win bonus
            const bonus = position.pnl_percentage >= 500 ? 1.3 : (position.pnl_percentage >= 200 ? 1.15 : 1.08);
            status.weight = Math.min(status.weight * bonus, STRATEGY_WEIGHT_MAX);
            this.patternStatuses.set(pattern.id, status);
            db.savePatternStatus(status);
          }
        }
      }

      logger.info(`📚 Saved winning pattern: Score ${analysis.overallScore}, ${position.pnl_percentage.toFixed(2)}% gain`);
    } catch (error) {
      logger.error('Error recording successful trade:', error);
    }
  }

  /**
   * Enhance winning patterns based on 2x+ winners
   */
  async enhanceWinningPatterns(position: any): Promise<void> {
    try {
      // Get all 2x+ winners
      const winners = db.getSuccessfulPatterns(100); // Get patterns with 100%+ return

      if (winners.length < 5) {
        logger.info('Not enough 2x+ winners yet to update strategy (need 5+)');
        return;
      }

      // Analyze common characteristics among winners
      const avgScore = winners.reduce((sum: number, w: any) => sum + w.overallScore, 0) / winners.length;
      const avgConfidence = winners.reduce((sum: number, w: any) => sum + w.confidence, 0) / winners.length;

      logger.info(`🧠 Learning from ${winners.length} 2x+ winners:`);
      logger.info(`   Average winning score: ${avgScore.toFixed(0)}`);
      logger.info(`   Average confidence: ${(avgConfidence * 100).toFixed(0)}%`);

      // Count pattern occurrences in winners
      const patternCounts: { [key: string]: number } = {};
      winners.forEach((w: any) => {
        if (w.patterns) {
          const patterns = w.patterns.split(', ');
          patterns.forEach((p: string) => {
            patternCounts[p] = (patternCounts[p] || 0) + 1;
          });
        }
      });

      // Log most successful patterns
      logger.info(`   Top winning patterns:`);
      Object.entries(patternCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .forEach(([pattern, count]) => {
          logger.info(`      • ${pattern}: ${count} winners`);
        });

      // Update strategy thresholds
      this.updateStrategyThresholds(avgScore, avgConfidence);
    } catch (error) {
      logger.error('Error enhancing winning patterns:', error);
    }
  }

  /**
   * Update strategy thresholds based on learned data
   */
  private updateStrategyThresholds(avgWinningScore: number, avgWinningConfidence: number): void {
    logger.info(`🎯 Updating strategy thresholds:`);
    logger.info(`   Target score threshold: ${avgWinningScore.toFixed(0)} (from 2x+ winners)`);
    logger.info(`   Target confidence threshold: ${(avgWinningConfidence * 100).toFixed(0)}%`);

    // In a full implementation, this would update config or pattern weights
    // For now, we log the insights for manual strategy adjustment
  }
}

export default new PatternLearner();
