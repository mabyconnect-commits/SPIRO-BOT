/**
 * Pattern Discovery Engine - Automatically discovers profitable patterns from simulation data
 *
 * Analyzes 100x winners and successful trades to:
 * 1. Identify common characteristics (features) of winning tokens
 * 2. Generate new patterns automatically
 * 3. Rank patterns by effectiveness
 * 4. Retire underperforming patterns
 */

import { AnalysisResult, RunnerPattern } from '../types';
import { simulationEngine, SimulationResult } from '../simulation/simulationEngine';
import db from '../database';
import logger from '../utils/logger';

// ============================================================
// TYPES
// ============================================================

export interface DiscoveredPattern {
  id: string;
  name: string;
  description: string;
  signals: PatternSignal[];
  confidence: number;
  sampleSize: number;
  avgReturn: number;
  winRate: number;
  discoveredAt: number;
  lastValidated: number;
  isActive: boolean;
}

export interface PatternSignal {
  type: 'wallet' | 'technical' | 'fundamental' | 'social';
  metric: string;
  operator: 'gte' | 'lte' | 'eq' | 'between';
  value: number | [number, number];
  weight: number;
  importance: number; // How much this signal contributed to pattern discovery
}

export interface FeatureImportance {
  feature: string;
  type: string;
  avgValueInWinners: number;
  avgValueInLosers: number;
  discriminativePower: number; // Higher = better at separating winners from losers
  prevalenceInWinners: number; // % of winners that have this feature
}

// ============================================================
// PATTERN DISCOVERY ENGINE
// ============================================================

export class PatternDiscoveryEngine {
  private discoveredPatterns: Map<string, DiscoveredPattern> = new Map();
  private featureImportance: FeatureImportance[] = [];
  private lastAnalysisTime: number = 0;
  private minSampleSize: number = 10;
  private analysisIntervalMs: number = 300000; // 5 minutes

  constructor() {
    this.loadPersistedPatterns();
  }

  /**
   * Analyze completed simulations to discover new patterns
   */
  async discoverPatterns(): Promise<DiscoveredPattern[]> {
    const now = Date.now();

    // Rate limit analysis
    if (now - this.lastAnalysisTime < this.analysisIntervalMs) {
      return Array.from(this.discoveredPatterns.values());
    }

    this.lastAnalysisTime = now;
    logger.info('🔬 Starting pattern discovery analysis...');

    // Get simulation results
    const allResults = simulationEngine.getCompletedResults(5000);
    if (allResults.length < this.minSampleSize) {
      logger.info(`Not enough data for pattern discovery (${allResults.length}/${this.minSampleSize})`);
      return [];
    }

    // Separate winners and losers
    const winners = allResults.filter(r => r.profitMultiple >= 2); // 2x+ is a winner
    const bigWinners = allResults.filter(r => r.profitMultiple >= 5); // 5x+ is a big winner
    const losers = allResults.filter(r => r.outcome === 'loss');

    logger.info(`Analyzing ${allResults.length} results: ${winners.length} winners (${bigWinners.length} big), ${losers.length} losers`);

    // Calculate feature importance
    this.featureImportance = this.calculateFeatureImportance(winners, losers);

    // Discover patterns from feature clusters
    const newPatterns = this.clusterFeaturesIntoPatterns(bigWinners, this.featureImportance);

    // Validate and store patterns
    for (const pattern of newPatterns) {
      if (pattern.confidence > 0.5 && pattern.sampleSize >= 3) {
        this.discoveredPatterns.set(pattern.id, pattern);
        logger.info(`✨ Discovered pattern: ${pattern.name} (${pattern.winRate.toFixed(0)}% WR, ${pattern.avgReturn.toFixed(0)}% avg)`);
      }
    }

    // Retire underperforming patterns
    this.retireUnderperformingPatterns();

    // Persist patterns
    this.persistPatterns();

    return Array.from(this.discoveredPatterns.values());
  }

  /**
   * Calculate which features best distinguish winners from losers
   */
  private calculateFeatureImportance(winners: SimulationResult[], losers: SimulationResult[]): FeatureImportance[] {
    const importance: FeatureImportance[] = [];

    // Define features to analyze (based on analysis snapshot)
    const features = [
      { name: 'marketCap', type: 'fundamental', getter: (r: SimulationResult) => (r as any).analysisSnapshot?.token?.marketCap || 0 },
      { name: 'liquidity', type: 'fundamental', getter: (r: SimulationResult) => (r as any).analysisSnapshot?.token?.liquidity || 0 },
      { name: 'volume24h', type: 'technical', getter: (r: SimulationResult) => (r as any).analysisSnapshot?.token?.volume24h || 0 },
      { name: 'holders', type: 'fundamental', getter: (r: SimulationResult) => (r as any).analysisSnapshot?.token?.holders || 0 },
      { name: 'priceChange24h', type: 'technical', getter: (r: SimulationResult) => (r as any).analysisSnapshot?.token?.priceChange24h || 0 },
      { name: 'overallScore', type: 'technical', getter: (r: SimulationResult) => (r as any).analysisSnapshot?.overallScore || 0 },
      { name: 'confidence', type: 'technical', getter: (r: SimulationResult) => (r as any).analysisSnapshot?.confidence || 0 },
      { name: 'liquidityLocked', type: 'fundamental', getter: (r: SimulationResult) => (r as any).analysisSnapshot?.fundamental?.liquidityLocked ? 1 : 0 },
      { name: 'volumeBreakout', type: 'technical', getter: (r: SimulationResult) => (r as any).analysisSnapshot?.technical?.volumeBreakout ? 1 : 0 },
      { name: 'trendingScore', type: 'social', getter: (r: SimulationResult) => (r as any).analysisSnapshot?.social?.trendingScore || 0 },
      { name: 'tokenAgeHours', type: 'fundamental', getter: (r: SimulationResult) => (r as any).analysisSnapshot?.fundamental?.tokenAge || 0 },
      { name: 'holderConcentration', type: 'fundamental', getter: (r: SimulationResult) => (r as any).analysisSnapshot?.fundamental?.holderConcentration || 0 },
    ];

    for (const feature of features) {
      // Calculate averages
      const winnerValues = winners.map(feature.getter).filter(v => v !== undefined && !isNaN(v));
      const loserValues = losers.map(feature.getter).filter(v => v !== undefined && !isNaN(v));

      if (winnerValues.length === 0 || loserValues.length === 0) continue;

      const avgWinner = winnerValues.reduce((a, b) => a + b, 0) / winnerValues.length;
      const avgLoser = loserValues.reduce((a, b) => a + b, 0) / loserValues.length;

      // Calculate discriminative power (how different are winners from losers)
      const stdWinner = this.standardDeviation(winnerValues);
      const stdLoser = this.standardDeviation(loserValues);
      const pooledStd = Math.sqrt((stdWinner ** 2 + stdLoser ** 2) / 2) || 1;
      const discriminativePower = Math.abs(avgWinner - avgLoser) / pooledStd;

      // Calculate prevalence (what % of winners have this feature above median)
      const median = this.median([...winnerValues, ...loserValues]);
      const prevalenceInWinners = winnerValues.filter(v => v > median).length / winnerValues.length;

      importance.push({
        feature: feature.name,
        type: feature.type,
        avgValueInWinners: avgWinner,
        avgValueInLosers: avgLoser,
        discriminativePower,
        prevalenceInWinners,
      });
    }

    // Sort by discriminative power
    importance.sort((a, b) => b.discriminativePower - a.discriminativePower);

    return importance;
  }

  /**
   * Cluster important features into patterns
   */
  private clusterFeaturesIntoPatterns(winners: SimulationResult[], importance: FeatureImportance[]): DiscoveredPattern[] {
    const patterns: DiscoveredPattern[] = [];

    // Take top 5 most discriminative features
    const topFeatures = importance.slice(0, 5);

    if (topFeatures.length < 2) return patterns;

    // Create pattern from top features
    const signals: PatternSignal[] = topFeatures.map(f => {
      // Determine operator and value based on winner vs loser comparison
      const operator = f.avgValueInWinners > f.avgValueInLosers ? 'gte' : 'lte';
      const threshold = f.avgValueInWinners > f.avgValueInLosers
        ? f.avgValueInWinners * 0.7 // 70% of winner average
        : f.avgValueInWinners * 1.3; // 130% of winner average

      return {
        type: f.type as 'wallet' | 'technical' | 'fundamental' | 'social',
        metric: f.feature,
        operator: operator as 'gte' | 'lte',
        value: threshold,
        weight: f.discriminativePower / topFeatures.reduce((s, t) => s + t.discriminativePower, 0),
        importance: f.discriminativePower,
      };
    });

    // Calculate pattern stats
    const winRate = winners.length / (winners.length + (importance[0]?.avgValueInLosers ? 1 : 0)) * 100;
    const avgReturn = winners.reduce((s, r) => s + r.roi, 0) / winners.length;

    const pattern: DiscoveredPattern = {
      id: `auto_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      name: `Auto-Discovered: ${topFeatures[0]?.feature || 'Unknown'}`,
      description: `Pattern based on ${topFeatures.map(f => f.feature).join(', ')}`,
      signals,
      confidence: Math.min(topFeatures[0]?.discriminativePower || 0, 1),
      sampleSize: winners.length,
      avgReturn,
      winRate,
      discoveredAt: Date.now(),
      lastValidated: Date.now(),
      isActive: true,
    };

    patterns.push(pattern);

    // Try to find sub-patterns within big winners (10x+)
    const tenXWinners = winners.filter(w => w.profitMultiple >= 10);
    if (tenXWinners.length >= 3) {
      const tenXImportance = this.calculateFeatureImportance(tenXWinners, winners.filter(w => w.profitMultiple < 10));
      const tenXTopFeatures = tenXImportance.slice(0, 3);

      if (tenXTopFeatures.length >= 2 && tenXTopFeatures[0]?.discriminativePower > 0.5) {
        const tenXSignals: PatternSignal[] = tenXTopFeatures.map(f => ({
          type: f.type as 'wallet' | 'technical' | 'fundamental' | 'social',
          metric: f.feature,
          operator: (f.avgValueInWinners > f.avgValueInLosers ? 'gte' : 'lte') as 'gte' | 'lte',
          value: f.avgValueInWinners * 0.8,
          weight: f.discriminativePower / tenXTopFeatures.reduce((s, t) => s + t.discriminativePower, 0),
          importance: f.discriminativePower,
        }));

        patterns.push({
          id: `auto_10x_${Date.now()}`,
          name: `10x Hunter: ${tenXTopFeatures[0]?.feature || 'Unknown'}`,
          description: `Pattern optimized for 10x+ returns`,
          signals: tenXSignals,
          confidence: Math.min(tenXTopFeatures[0]?.discriminativePower || 0, 1),
          sampleSize: tenXWinners.length,
          avgReturn: tenXWinners.reduce((s, r) => s + r.roi, 0) / tenXWinners.length,
          winRate: 100, // By definition, all are 10x winners
          discoveredAt: Date.now(),
          lastValidated: Date.now(),
          isActive: true,
        });
      }
    }

    return patterns;
  }

  /**
   * Retire patterns that are no longer performing
   */
  private retireUnderperformingPatterns(): void {
    const recentResults = simulationEngine.getCompletedResults(1000);
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    for (const [id, pattern] of this.discoveredPatterns) {
      // Skip recently discovered patterns
      if (pattern.discoveredAt > thirtyDaysAgo) continue;

      // Check recent performance
      // For now, just deactivate if win rate drops significantly
      if (pattern.winRate < 30 && pattern.sampleSize > 20) {
        pattern.isActive = false;
        logger.info(`📉 Retired pattern: ${pattern.name} (win rate dropped to ${pattern.winRate.toFixed(0)}%)`);
      }
    }
  }

  /**
   * Get active discovered patterns as RunnerPatterns for use in analyzer
   */
  getActivePatterns(): RunnerPattern[] {
    return Array.from(this.discoveredPatterns.values())
      .filter(p => p.isActive)
      .map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        confidence: p.confidence,
        successRate: p.winRate / 100,
        avgReturn: p.avgReturn,
        sampleSize: p.sampleSize,
        signals: p.signals.map(s => ({
          type: s.type,
          metric: s.metric,
          operator: s.operator,
          value: s.value as number,
          weight: s.weight,
        })),
      }));
  }

  /**
   * Get feature importance ranking
   */
  getFeatureImportance(): FeatureImportance[] {
    return this.featureImportance;
  }

  /**
   * Get all discovered patterns
   */
  getAllPatterns(): DiscoveredPattern[] {
    return Array.from(this.discoveredPatterns.values());
  }

  /**
   * Generate report
   */
  generateReport(): string {
    const patterns = this.getAllPatterns();
    const active = patterns.filter(p => p.isActive);

    let report = `🔬 *Pattern Discovery Report*\n\n`;
    report += `📊 *Summary*\n`;
    report += `• Total Patterns: ${patterns.length}\n`;
    report += `• Active: ${active.length}\n`;
    report += `• Retired: ${patterns.length - active.length}\n\n`;

    if (this.featureImportance.length > 0) {
      report += `🎯 *Top Discriminative Features*\n`;
      for (const f of this.featureImportance.slice(0, 5)) {
        const direction = f.avgValueInWinners > f.avgValueInLosers ? '↑' : '↓';
        report += `• ${f.feature}: ${direction} (power: ${f.discriminativePower.toFixed(2)})\n`;
      }
      report += '\n';
    }

    if (active.length > 0) {
      report += `✨ *Active Discovered Patterns*\n`;
      for (const p of active) {
        report += `• *${p.name}*\n`;
        report += `  WR: ${p.winRate.toFixed(0)}% | Avg: ${p.avgReturn.toFixed(0)}% | Samples: ${p.sampleSize}\n`;
      }
    }

    return report;
  }

  // ============================================================
  // UTILITIES
  // ============================================================

  private standardDeviation(values: number[]): number {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squareDiffs = values.map(v => (v - mean) ** 2);
    return Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / values.length);
  }

  private median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // ============================================================
  // PERSISTENCE
  // ============================================================

  private loadPersistedPatterns(): void {
    // Load from database if available
    try {
      const stored = (db as any).getDiscoveredPatterns?.();
      if (stored) {
        for (const p of stored) {
          this.discoveredPatterns.set(p.id, p);
        }
        logger.info(`Loaded ${this.discoveredPatterns.size} discovered patterns from database`);
      }
    } catch {
      // Table doesn't exist yet, will be created on first persist
    }
  }

  private persistPatterns(): void {
    try {
      (db as any).db?.exec(`
        CREATE TABLE IF NOT EXISTS discovered_patterns (
          id TEXT PRIMARY KEY,
          name TEXT,
          description TEXT,
          signals TEXT,
          confidence REAL,
          sample_size INTEGER,
          avg_return REAL,
          win_rate REAL,
          discovered_at INTEGER,
          last_validated INTEGER,
          is_active INTEGER
        )
      `);

      const stmt = (db as any).db?.prepare(`
        INSERT OR REPLACE INTO discovered_patterns
        (id, name, description, signals, confidence, sample_size, avg_return, win_rate, discovered_at, last_validated, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const p of this.discoveredPatterns.values()) {
        stmt?.run(
          p.id, p.name, p.description, JSON.stringify(p.signals),
          p.confidence, p.sampleSize, p.avgReturn, p.winRate,
          p.discoveredAt, p.lastValidated, p.isActive ? 1 : 0
        );
      }
    } catch (error) {
      logger.error('Error persisting discovered patterns:', error);
    }
  }
}

export const patternDiscovery = new PatternDiscoveryEngine();
export default patternDiscovery;
