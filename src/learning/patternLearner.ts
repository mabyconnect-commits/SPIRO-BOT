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
    // This would query the database for recent trades matching this pattern
    // For now, simplified implementation
    return [];
  }

  private boostPatternPriority(patternId: string): void {
    // This would adjust pattern weights or thresholds
    logger.info(`Boosting priority for pattern ${patternId} to prevent drift`);
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
}

export default new PatternLearner();
