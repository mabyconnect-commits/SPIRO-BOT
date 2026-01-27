import { RunnerPattern, LearningData, TradePosition } from '../types';
import { config, RUNNER_PATTERNS } from '../config';
import db from '../database';
import logger from '../utils/logger';

export class PatternLearner {
  private antiDriftThreshold = config.learning.antiDriftThreshold;

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
    }

    // Check for drift and adjust if needed
    this.checkForDrift();
  }

  /**
   * Get updated pattern with learned performance
   */
  getUpdatedPatterns(): RunnerPattern[] {
    const updatedPatterns: RunnerPattern[] = [];

    for (const pattern of RUNNER_PATTERNS) {
      const performance = db.getPatternPerformance(pattern.id);

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

    const bayesianConfidence = posteriorSuccessRate + confidenceFromSampleSize;

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
    // Boost pattern priority by 1.5x for 24 hours
    const boostMultiplier = 1.5;
    const durationHours = 24;

    db.setPatternBoost(patternId, boostMultiplier, 'Anti-drift: underused winning pattern', durationHours);
    logger.info(`🔥 Boosted pattern ${patternId} priority by ${boostMultiplier}x for ${durationHours}h to prevent drift`);
  }

  /**
   * Get boost multiplier for a pattern (used in scoring)
   */
  getPatternBoostMultiplier(patternId: string): number {
    return db.getPatternBoost(patternId);
  }

  /**
   * Get all active pattern boosts
   */
  getActiveBoosts(): { patternId: string; boost: number; reason: string }[] {
    return db.getAllPatternBoosts();
  }

  /**
   * Get pattern recommendations based on current performance
   */
  getPatternRecommendations(): { pattern: RunnerPattern; reason: string }[] {
    const patterns = this.getUpdatedPatterns();
    const recommendations: { pattern: RunnerPattern; reason: string }[] = [];

    for (const pattern of patterns) {
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
          reason: `🔥 Hot pattern! ${(pattern.successRate * 100).toFixed(0)}% win rate over ${pattern.sampleSize} trades`,
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
   * Generate learning report
   */
  generateLearningReport(): string {
    const patterns = this.getUpdatedPatterns();

    let report = '📊 **Pattern Learning Report**\n\n';

    patterns.forEach(pattern => {
      if (pattern.sampleSize === 0) return;

      report += `**${pattern.name}**\n`;
      report += `• Trades: ${pattern.sampleSize}\n`;
      report += `• Win Rate: ${(pattern.successRate * 100).toFixed(1)}%\n`;
      report += `• Avg Return: ${pattern.avgReturn.toFixed(1)}%\n`;
      report += `• Confidence: ${(pattern.confidence * 100).toFixed(1)}%\n\n`;
    });

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
    // Validate inputs
    if (!isFinite(avgWinningScore) || !isFinite(avgWinningConfidence)) {
      logger.warn('Invalid threshold values, skipping update');
      return;
    }

    // Store learned thresholds in database
    db.setStrategySetting('learned_min_score', avgWinningScore);
    db.setStrategySetting('learned_min_confidence', avgWinningConfidence);
    db.setStrategySetting('thresholds_updated_at', Date.now());

    logger.info(`🎯 Strategy thresholds updated and saved:`);
    logger.info(`   📊 Target score threshold: ${avgWinningScore.toFixed(0)} (from 2x+ winners)`);
    logger.info(`   🎯 Target confidence threshold: ${(avgWinningConfidence * 100).toFixed(0)}%`);
  }

  /**
   * Get learned strategy settings
   */
  getLearnedSettings(): { minScore: number; minConfidence: number; lastUpdated: number } {
    return {
      minScore: db.getStrategySetting('learned_min_score', 25), // Default 25
      minConfidence: db.getStrategySetting('learned_min_confidence', 0.5), // Default 50%
      lastUpdated: db.getStrategySetting('thresholds_updated_at', 0),
    };
  }
}

export default new PatternLearner();
