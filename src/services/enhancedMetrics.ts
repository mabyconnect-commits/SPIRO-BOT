/**
 * Enhanced Metrics Service
 *
 * Tracks advanced token metrics including:
 * - Dev wallet behavior (selling patterns, activity)
 * - Buy/sell pressure (detailed transaction analysis)
 * - Transaction velocity (activity rate and trends)
 */

import { dexScreener, helius } from './apiClients';
import {
  DevWalletBehavior,
  BuySellPressure,
  TransactionVelocity,
  EnhancedTokenMetrics,
} from '../types';
import logger from '../utils/logger';

// Safe parseFloat helper
function safeNum(value: any, defaultValue: number = 0): number {
  if (value === undefined || value === null) return defaultValue;
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return isNaN(parsed) || !isFinite(parsed) ? defaultValue : parsed;
}

class EnhancedMetricsService {
  // Cache to avoid repeated API calls
  private metricsCache: Map<string, { metrics: EnhancedTokenMetrics; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 60000; // 1 minute cache

  /**
   * Get comprehensive enhanced metrics for a token
   */
  async getEnhancedMetrics(contractAddress: string, dexData?: any): Promise<EnhancedTokenMetrics> {
    // Check cache
    const cached = this.metricsCache.get(contractAddress);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.metrics;
    }

    try {
      // Fetch DexScreener data if not provided
      if (!dexData) {
        dexData = await dexScreener.getTokenData(contractAddress);
      }

      // Calculate all metrics in parallel
      const [devWallet, buySellPressure, transactionVelocity] = await Promise.all([
        this.analyzeDevWallet(contractAddress, dexData),
        this.analyzeBuySellPressure(dexData),
        this.analyzeTransactionVelocity(dexData),
      ]);

      // Calculate overall health score and risk flags
      const { healthScore, riskFlags, bullishSignals } = this.calculateHealthScore(
        devWallet,
        buySellPressure,
        transactionVelocity
      );

      const metrics: EnhancedTokenMetrics = {
        devWallet,
        buySellPressure,
        transactionVelocity,
        overallHealthScore: healthScore,
        riskFlags,
        bullishSignals,
      };

      // Cache the result
      this.metricsCache.set(contractAddress, { metrics, timestamp: Date.now() });

      return metrics;
    } catch (error) {
      logger.error(`Error getting enhanced metrics for ${contractAddress}:`, error);

      // Return default metrics on error
      return this.getDefaultMetrics();
    }
  }

  /**
   * Analyze dev wallet behavior
   */
  private async analyzeDevWallet(contractAddress: string, dexData: any): Promise<DevWalletBehavior> {
    const defaultBehavior: DevWalletBehavior = {
      devWalletAddress: null,
      totalBalance: 0,
      percentageOfSupply: 0,
      recentSells: 0,
      sellPressure: 0,
      lastActivity: null,
      isActive: false,
      isDumping: false,
      holdingDuration: 0,
      suspiciousActivity: false,
    };

    try {
      // Get holder distribution from Helius to identify dev wallet
      const holderDistribution = await helius.getHolderDistribution(contractAddress, 50);

      if (!holderDistribution || !holderDistribution.topHolders.length) {
        return defaultBehavior;
      }

      // Typically, dev wallet is one of the top holders (often #1 or #2)
      // Look for wallets with >5% that aren't liquidity pools
      const topHolders = holderDistribution.topHolders;
      const potentialDevWallet = topHolders.find(h =>
        h.percentage > 5 && h.percentage < 50 // Between 5-50% is suspicious dev wallet range
      );

      if (!potentialDevWallet) {
        return defaultBehavior;
      }

      // Analyze the potential dev wallet
      const devAddress = potentialDevWallet.address;
      const percentage = potentialDevWallet.percentage;

      // Check holder changes for accumulation/distribution signals
      const holderChanges = await helius.detectHolderChanges(contractAddress);
      const distributingDev = holderChanges?.distributingAddresses.find(c => c.address === devAddress);
      const recentSells = distributingDev ? 1 : 0;

      // Calculate sell pressure from distribution signals (0-1)
      let sellPressure = 0;
      if (distributingDev) {
        sellPressure = Math.min(1, Math.abs(distributingDev.changePercent) / 100);
      }

      // Check for dumping behavior (selling >10% of holdings)
      const isDumping = sellPressure > 0.1;

      // Check for suspicious patterns
      const suspiciousActivity =
        sellPressure > 0.3 || // Selling >30% is very suspicious
        percentage > 30; // >30% concentration is risky

      return {
        devWalletAddress: devAddress,
        totalBalance: potentialDevWallet.balance,
        percentageOfSupply: percentage,
        recentSells,
        sellPressure,
        lastActivity: null,
        isActive: holderChanges?.overallTrend !== 'neutral',
        isDumping,
        holdingDuration: 0, // Would need historical data to calculate
        suspiciousActivity,
      };
    } catch (error) {
      logger.debug(`Error analyzing dev wallet for ${contractAddress}:`, error);
      return defaultBehavior;
    }
  }

  /**
   * Analyze buy/sell pressure from DexScreener data
   */
  private analyzeBuySellPressure(dexData: any): BuySellPressure {
    const txns = dexData?.txns || {};
    const volume = dexData?.volume || {};

    // Extract transaction counts
    const txns1h = txns.h1 || { buys: 0, sells: 0 };
    const txns6h = txns.h6 || { buys: 0, sells: 0 };
    const txns24h = txns.h24 || { buys: 0, sells: 0 };

    const buys1h = safeNum(txns1h.buys);
    const sells1h = safeNum(txns1h.sells);
    const buys6h = safeNum(txns6h.buys);
    const sells6h = safeNum(txns6h.sells);
    const buys24h = safeNum(txns24h.buys);
    const sells24h = safeNum(txns24h.sells);

    // Calculate buy to sell ratio (protect against division by zero)
    const buyToSellRatio = sells24h > 0 ? buys24h / sells24h : (buys24h > 0 ? 2 : 1);

    // Estimate buy/sell volume (DexScreener only provides total volume)
    // Use transaction counts to estimate split
    const totalTxns = buys24h + sells24h;
    const volume24h = safeNum(volume.h24);
    const buyVolume24h = totalTxns > 0 ? (buys24h / totalTxns) * volume24h : volume24h / 2;
    const sellVolume24h = totalTxns > 0 ? (sells24h / totalTxns) * volume24h : volume24h / 2;

    // Volume ratio and net flow
    const volumeRatio = sellVolume24h > 0 ? buyVolume24h / sellVolume24h : (buyVolume24h > 0 ? 2 : 1);
    const netFlow = buyVolume24h - sellVolume24h;

    // Determine pressure level
    let pressure: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell';
    if (buyToSellRatio >= 2.0) pressure = 'strong_buy';
    else if (buyToSellRatio >= 1.3) pressure = 'buy';
    else if (buyToSellRatio >= 0.7) pressure = 'neutral';
    else if (buyToSellRatio >= 0.4) pressure = 'sell';
    else pressure = 'strong_sell';

    // Determine momentum (comparing 1h to 6h average)
    const buys1hAvg = buys6h / 6;
    const sells1hAvg = sells6h / 6;
    const recentBuyPressure = buys1h - sells1h;
    const avgBuyPressure = buys1hAvg - sells1hAvg;

    let momentum: 'accelerating' | 'stable' | 'decelerating';
    if (recentBuyPressure > avgBuyPressure * 1.5) momentum = 'accelerating';
    else if (recentBuyPressure < avgBuyPressure * 0.5) momentum = 'decelerating';
    else momentum = 'stable';

    return {
      buys1h,
      sells1h,
      buys6h,
      sells6h,
      buys24h,
      sells24h,
      buyVolume24h,
      sellVolume24h,
      buyToSellRatio,
      volumeRatio,
      netFlow,
      pressure,
      momentum,
    };
  }

  /**
   * Analyze transaction velocity
   */
  private analyzeTransactionVelocity(dexData: any): TransactionVelocity {
    const txns = dexData?.txns || {};
    const volume = dexData?.volume || {};

    // Extract transaction counts
    const txns1h = txns.h1 || { buys: 0, sells: 0 };
    const txns6h = txns.h6 || { buys: 0, sells: 0 };
    const txns24h = txns.h24 || { buys: 0, sells: 0 };

    const totalTxns1h = safeNum(txns1h.buys) + safeNum(txns1h.sells);
    const totalTxns6h = safeNum(txns6h.buys) + safeNum(txns6h.sells);
    const totalTxns24h = safeNum(txns24h.buys) + safeNum(txns24h.sells);

    // Estimate shorter timeframes from hourly data
    const txns5m = Math.round(totalTxns1h / 12); // Estimate from 1h
    const txns1m = Math.round(totalTxns1h / 60); // Estimate from 1h

    // Calculate average transaction size
    const volume24h = safeNum(volume.h24);
    const avgTxSize = totalTxns24h > 0 ? volume24h / totalTxns24h : 0;

    // Calculate velocity score (0-100)
    // Based on transaction frequency - 100+ txns/hour is very active
    const txnsPerHour = totalTxns24h / 24;
    const velocityScore = Math.min(100, (txnsPerHour / 100) * 100);

    // Determine velocity trend
    const recentRate = totalTxns1h;
    const avgHourlyRate = totalTxns24h / 24;

    let velocityTrend: 'increasing' | 'stable' | 'decreasing';
    if (recentRate > avgHourlyRate * 1.5) velocityTrend = 'increasing';
    else if (recentRate < avgHourlyRate * 0.5) velocityTrend = 'decreasing';
    else velocityTrend = 'stable';

    // Detect activity spikes (3x normal rate)
    const isSpike = recentRate > avgHourlyRate * 3;

    // Estimate unique wallets (DexScreener doesn't provide this directly)
    // Rough estimate: unique wallets ~= sqrt(total transactions) * 2
    const uniqueWallets24h = Math.round(Math.sqrt(totalTxns24h) * 2);

    return {
      txns1m,
      txns5m,
      txns1h: totalTxns1h,
      txns6h: totalTxns6h,
      txns24h: totalTxns24h,
      avgTxSize,
      velocityScore,
      velocityTrend,
      isSpike,
      uniqueWallets24h,
    };
  }

  /**
   * Calculate overall health score and identify flags
   */
  private calculateHealthScore(
    devWallet: DevWalletBehavior,
    buySellPressure: BuySellPressure,
    transactionVelocity: TransactionVelocity
  ): { healthScore: number; riskFlags: string[]; bullishSignals: string[] } {
    let healthScore = 50; // Start at neutral
    const riskFlags: string[] = [];
    const bullishSignals: string[] = [];

    // === DEV WALLET FACTORS ===
    if (devWallet.isDumping) {
      healthScore -= 20;
      riskFlags.push('Dev wallet dumping');
    }
    if (devWallet.suspiciousActivity) {
      healthScore -= 15;
      riskFlags.push('Suspicious dev activity');
    }
    if (devWallet.percentageOfSupply > 20) {
      healthScore -= 10;
      riskFlags.push(`High dev concentration (${devWallet.percentageOfSupply.toFixed(1)}%)`);
    }
    if (devWallet.sellPressure > 0.2) {
      healthScore -= 10;
      riskFlags.push('Dev selling pressure');
    }
    // Positive: Dev holding steady
    if (devWallet.percentageOfSupply > 0 && devWallet.sellPressure < 0.05) {
      healthScore += 5;
      bullishSignals.push('Dev wallet stable');
    }

    // === BUY/SELL PRESSURE FACTORS ===
    if (buySellPressure.pressure === 'strong_buy') {
      healthScore += 15;
      bullishSignals.push('Strong buying pressure');
    } else if (buySellPressure.pressure === 'buy') {
      healthScore += 10;
      bullishSignals.push('Buying pressure');
    } else if (buySellPressure.pressure === 'strong_sell') {
      healthScore -= 15;
      riskFlags.push('Strong selling pressure');
    } else if (buySellPressure.pressure === 'sell') {
      healthScore -= 10;
      riskFlags.push('Selling pressure');
    }

    if (buySellPressure.momentum === 'accelerating') {
      healthScore += 10;
      bullishSignals.push('Momentum accelerating');
    } else if (buySellPressure.momentum === 'decelerating') {
      healthScore -= 5;
      riskFlags.push('Momentum slowing');
    }

    if (buySellPressure.netFlow > 50000) {
      healthScore += 10;
      bullishSignals.push('Positive net flow');
    } else if (buySellPressure.netFlow < -50000) {
      healthScore -= 10;
      riskFlags.push('Negative net flow');
    }

    // === TRANSACTION VELOCITY FACTORS ===
    if (transactionVelocity.velocityScore > 70) {
      healthScore += 10;
      bullishSignals.push('High trading activity');
    } else if (transactionVelocity.velocityScore < 20) {
      healthScore -= 5;
      riskFlags.push('Low trading activity');
    }

    if (transactionVelocity.isSpike) {
      if (buySellPressure.buyToSellRatio > 1.5) {
        healthScore += 15;
        bullishSignals.push('Activity spike with buying');
      } else if (buySellPressure.buyToSellRatio < 0.7) {
        healthScore -= 15;
        riskFlags.push('Activity spike with selling');
      }
    }

    if (transactionVelocity.velocityTrend === 'increasing') {
      healthScore += 5;
      bullishSignals.push('Activity increasing');
    } else if (transactionVelocity.velocityTrend === 'decreasing') {
      healthScore -= 5;
      riskFlags.push('Activity decreasing');
    }

    // Clamp score to 0-100
    healthScore = Math.max(0, Math.min(100, healthScore));

    return { healthScore, riskFlags, bullishSignals };
  }

  /**
   * Get default metrics when API calls fail
   */
  private getDefaultMetrics(): EnhancedTokenMetrics {
    return {
      devWallet: {
        devWalletAddress: null,
        totalBalance: 0,
        percentageOfSupply: 0,
        recentSells: 0,
        sellPressure: 0,
        lastActivity: null,
        isActive: false,
        isDumping: false,
        holdingDuration: 0,
        suspiciousActivity: false,
      },
      buySellPressure: {
        buys1h: 0,
        sells1h: 0,
        buys6h: 0,
        sells6h: 0,
        buys24h: 0,
        sells24h: 0,
        buyVolume24h: 0,
        sellVolume24h: 0,
        buyToSellRatio: 1,
        volumeRatio: 1,
        netFlow: 0,
        pressure: 'neutral',
        momentum: 'stable',
      },
      transactionVelocity: {
        txns1m: 0,
        txns5m: 0,
        txns1h: 0,
        txns6h: 0,
        txns24h: 0,
        avgTxSize: 0,
        velocityScore: 0,
        velocityTrend: 'stable',
        isSpike: false,
        uniqueWallets24h: 0,
      },
      overallHealthScore: 50,
      riskFlags: ['Unable to fetch detailed metrics'],
      bullishSignals: [],
    };
  }

  /**
   * Clear the metrics cache
   */
  clearCache(): void {
    this.metricsCache.clear();
  }

  /**
   * Get cached metrics for a token (if available)
   */
  getCachedMetrics(contractAddress: string): EnhancedTokenMetrics | null {
    const cached = this.metricsCache.get(contractAddress);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.metrics;
    }
    return null;
  }
}

export const enhancedMetrics = new EnhancedMetricsService();
export default enhancedMetrics;
