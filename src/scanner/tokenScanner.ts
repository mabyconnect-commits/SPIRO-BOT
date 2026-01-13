import { dexScreener } from '../services/apiClients';
import tokenAnalyzer from '../analyzer/tokenAnalyzer';
import tradingEngine from '../trading/tradingEngine';
import patternLearner from '../learning/patternLearner';
import { config } from '../config';
import logger from '../utils/logger';
import { AnalysisResult } from '../types';
import db from '../database';

export class TokenScanner {
  private isScanning: boolean = false;
  private scanInterval: NodeJS.Timeout | null = null;
  private alertCallbacks: Array<(analysis: AnalysisResult) => void> = [];
  private stats = {
    tokensScanned: 0,
    alertsTriggered: 0,
    lastScanTime: Date.now(),
  };

  /**
   * Start continuous scanning
   */
  start(): void {
    if (this.isScanning) {
      logger.warn('Scanner already running');
      return;
    }

    this.isScanning = true;
    logger.info('🔍 Token scanner started');

    // Run initial scan
    this.scan();

    // Schedule periodic scans
    this.scanInterval = setInterval(() => {
      this.scan();
    }, config.scanner.scanIntervalMs);
  }

  /**
   * Stop scanning
   */
  stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }

    this.isScanning = false;
    logger.info('Scanner stopped');
  }

  /**
   * Register callback for alerts
   */
  onAlert(callback: (analysis: AnalysisResult) => void): void {
    this.alertCallbacks.push(callback);
  }

  /**
   * Check if scanner is active
   */
  isActive(): boolean {
    return this.isScanning;
  }

  /**
   * Get scanning statistics
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Perform a scan
   */
  private async scan(): Promise<void> {
    try {
      logger.info('Starting scan cycle...');

      // Get trending tokens from DexScreener
      const trendingTokens = await this.getTrendingTokens();

      logger.info(`Found ${trendingTokens.length} trending tokens`);

      for (const tokenAddress of trendingTokens) {
        await this.analyzeAndAct(tokenAddress);
        this.stats.tokensScanned++;
        this.stats.lastScanTime = Date.now();

        // Small delay to avoid rate limits
        await this.sleep(1000);
      }

      logger.info('Scan cycle complete');
    } catch (error) {
      logger.error('Scan error:', error);
    }
  }

  /**
   * Get trending tokens from various sources
   */
  private async getTrendingTokens(): Promise<string[]> {
    const tokens: string[] = [];

    try {
      // Search for high-volume tokens
      const searches = ['sol', 'pump', 'bonk', 'wif', 'meme'];

      for (const query of searches) {
        const pairs = await dexScreener.searchPairs(query);

        for (const pair of pairs) {
          if (!pair.baseToken?.address) continue;

          const volume24h = parseFloat(pair.volume?.h24 || '0');
          const liquidity = parseFloat(pair.liquidity?.usd || '0');

          // Filter by minimum requirements
          if (
            volume24h >= config.scanner.minVolume24hUsd &&
            liquidity >= config.scanner.minLiquidityUsd
          ) {
            tokens.push(pair.baseToken.address);
          }
        }
      }
    } catch (error) {
      logger.error('Error fetching trending tokens:', error);
    }

    // Remove duplicates
    return [...new Set(tokens)];
  }

  /**
   * Analyze a token and take action
   */
  private async analyzeAndAct(contractAddress: string): Promise<void> {
    try {
      const analysis = await tokenAnalyzer.analyzeToken(contractAddress);

      if (!analysis) return;

      logger.info(
        `${analysis.token.symbol}: Score ${analysis.overallScore.toFixed(0)}, ` +
        `Confidence ${(analysis.confidence * 100).toFixed(0)}%, ` +
        `Recommendation: ${analysis.recommendation}`
      );

      // Always paper trade every signal (as per requirement)
      if (analysis.recommendation === 'strong_buy' || analysis.recommendation === 'buy') {
        // Paper trade regardless of auto-trade settings
        await tradingEngine.buy(analysis, 1.0, 0, true);

        // Send alert to users
        this.sendAlert(analysis);

        // Auto-trade for users who have it enabled
        await this.handleAutoTrade(analysis);
      }
    } catch (error) {
      logger.error(`Error analyzing ${contractAddress}:`, error);
    }
  }

  /**
   * Handle auto-trading for users with it enabled
   */
  private async handleAutoTrade(analysis: AnalysisResult): Promise<void> {
    // In a multi-user system, you would iterate through users with auto_trade enabled
    // For now, checking if auto-trade is enabled via config

    // Get user with ID 0 (default/admin)
    const userSettings = db.getUserSettings(0);

    if (userSettings && userSettings.autoTrade && !userSettings.paperTrading) {
      logger.info(`Auto-trading for user 0: ${analysis.token.symbol}`);

      const preset = userSettings.preset;
      await tradingEngine.buy(analysis, 1.0, 0, false);
    }
  }

  /**
   * Send alert to registered callbacks
   */
  private sendAlert(analysis: AnalysisResult): void {
    this.stats.alertsTriggered++;
    for (const callback of this.alertCallbacks) {
      try {
        callback(analysis);
      } catch (error) {
        logger.error('Error in alert callback:', error);
      }
    }
  }

  /**
   * Manually scan a specific token
   */
  async scanToken(contractAddress: string): Promise<AnalysisResult | null> {
    return await tokenAnalyzer.analyzeToken(contractAddress);
  }

  /**
   * Monitor open positions and manage them
   */
  async monitorPositions(userId: number = 0): Promise<void> {
    const positions = db.getOpenPositions(userId);

    for (const position of positions) {
      await tradingEngine.updatePosition(position);

      if (tradingEngine.shouldClosePosition(position, userId)) {
        logger.info(`Closing position ${position.symbol} due to take profit/stop loss`);

        const success = await tradingEngine.sell(position, position.type === 'paper');

        if (success) {
          // Record learning data
          const patterns = patternLearner.getUpdatedPatterns();
          patternLearner.recordTrade(position, patterns);
        }
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default new TokenScanner();
