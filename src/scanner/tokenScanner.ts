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
  private paperTradeInterval: NodeJS.Timeout | null = null;
  private alertCallbacks: Array<(analysis: AnalysisResult) => void> = [];
  private scanNotifyCallbacks: Array<(tokenInfo: { address: string; name?: string; symbol?: string }) => void> = [];
  private buySignalCallbacks: Array<(analysis: AnalysisResult) => void> = [];
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
   * Register callback for scan notifications
   */
  onScanNotify(callback: (tokenInfo: { address: string; name?: string; symbol?: string }) => void): void {
    this.scanNotifyCallbacks.push(callback);
  }

  /**
   * Register callback for buy signals
   */
  onBuySignal(callback: (analysis: AnalysisResult) => void): void {
    this.buySignalCallbacks.push(callback);
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
        // Notify that we're scanning this token
        this.notifyScan(tokenAddress);

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
   * Get trending tokens from launchpads only (PumpFun, Meteora, etc.)
   */
  private async getTrendingTokens(): Promise<string[]> {
    const tokens: string[] = [];

    try {
      logger.info('🚀 Scanning launchpad tokens (PumpFun, Meteora, etc.)...');

      // Get new pairs from Solana
      const allPairs = await dexScreener.getNewPairs();
      logger.info(`Found ${allPairs.length} total pairs`);

      // Filter for launchpad tokens only
      const launchpadPairs = allPairs.filter(pair => dexScreener.isFromLaunchpad(pair));
      logger.info(`Filtered to ${launchpadPairs.length} launchpad tokens`);

      // Also search for specific launchpad keywords
      const searches = ['pump', 'pumpfun', 'meteora'];
      for (const query of searches) {
        const pairs = await dexScreener.searchPairs(query);

        for (const pair of pairs) {
          if (dexScreener.isFromLaunchpad(pair)) {
            launchpadPairs.push(pair);
          }
        }
      }

      // Process launchpad pairs
      for (const pair of launchpadPairs) {
        if (!pair.baseToken?.address) continue;

        const volume24h = parseFloat(pair.volume?.h24 || '0');
        const liquidity = parseFloat(pair.liquidity?.usd || '0');

        // Lower requirements for launchpad tokens (they're newer)
        if (
          volume24h >= config.scanner.minVolume24hUsd * 0.5 && // 50% of normal requirement
          liquidity >= config.scanner.minLiquidityUsd * 0.5    // 50% of normal requirement
        ) {
          tokens.push(pair.baseToken.address);
          logger.info(`✅ Added ${pair.baseToken.symbol || 'token'} from ${pair.dexId}`);
        }
      }
    } catch (error) {
      logger.error('Error fetching launchpad tokens:', error);
    }

    // Remove duplicates
    const uniqueTokens = [...new Set(tokens)];
    logger.info(`📊 Final count: ${uniqueTokens.length} unique launchpad tokens to analyze`);
    return uniqueTokens;
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

      // PAPER TRADE ALL SCANNED TOKENS (not just buy signals)
      // This allows us to learn from all patterns, including failed ones
      logger.info(`📝 Paper trading ${analysis.token.symbol} for learning...`);
      await tradingEngine.buy(analysis, 0.1, 0, true); // Small amount (0.1 SOL) for tracking

      // Check if this is a good token (potential 2x or better)
      const isPotentialRunner = this.isPotentialRunner(analysis);

      // Send buy signal if it's a good token
      if (isPotentialRunner) {
        logger.info(`🚨 BUY SIGNAL: ${analysis.token.symbol} shows 2x+ potential!`);
        this.sendBuySignal(analysis);
      }

      // Send alert to users for buy/strong_buy recommendations
      if (analysis.recommendation === 'strong_buy' || analysis.recommendation === 'buy') {
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

      // Track 2x+ winners for learning
      if (position.pnlPercentage && position.pnlPercentage >= 100) {
        logger.info(`🎉 2X WINNER DETECTED: ${position.symbol} at +${position.pnlPercentage.toFixed(2)}%!`);
        await this.record2xWinner(position);
      }

      if (tradingEngine.shouldClosePosition(position, userId)) {
        logger.info(`Closing position ${position.symbol} due to take profit/stop loss`);

        const success = await tradingEngine.sell(position, position.type === 'paper');

        if (success) {
          // Record learning data
          const patterns = patternLearner.getUpdatedPatterns();
          patternLearner.recordTrade(position, patterns);

          // If this was a 2x+ winner, extract winning patterns
          if (position.pnlPercentage && position.pnlPercentage >= 100) {
            await this.learnFrom2xWinner(position);
          }
        }
      }
    }
  }

  /**
   * Record a 2x+ winner for learning
   */
  private async record2xWinner(position: any): Promise<void> {
    try {
      // Get the original analysis for this position
      const analysis = await tokenAnalyzer.analyzeToken(position.contract_address);
      if (!analysis) return;

      logger.info(`📚 Recording 2x+ winner pattern for ${position.symbol}`);
      logger.info(`   Score: ${analysis.overallScore}, Confidence: ${(analysis.confidence * 100).toFixed(0)}%`);
      logger.info(`   Patterns matched: ${analysis.matchedPatterns?.map(p => p.name).join(', ')}`);

      // Store this as a successful example
      patternLearner.recordSuccessfulTrade(position, analysis);
    } catch (error) {
      logger.error('Error recording 2x winner:', error);
    }
  }

  /**
   * Learn from 2x+ winners to improve strategy
   */
  private async learnFrom2xWinner(position: any): Promise<void> {
    try {
      logger.info(`🧠 Learning from ${position.symbol} (${position.pnlPercentage.toFixed(2)}% gain)...`);

      // Extract patterns and update weights
      await patternLearner.enhanceWinningPatterns(position);

      logger.info(`✅ Strategy updated based on ${position.symbol}'s success`);
    } catch (error) {
      logger.error('Error learning from winner:', error);
    }
  }

  /**
   * Notify scan callbacks that a token is being scanned
   */
  private notifyScan(contractAddress: string): void {
    for (const callback of this.scanNotifyCallbacks) {
      try {
        callback({ address: contractAddress });
      } catch (error) {
        logger.error('Error in scan notify callback:', error);
      }
    }
  }

  /**
   * Send buy signal to registered callbacks
   */
  private sendBuySignal(analysis: AnalysisResult): void {
    for (const callback of this.buySignalCallbacks) {
      try {
        callback(analysis);
      } catch (error) {
        logger.error('Error in buy signal callback:', error);
      }
    }
  }

  /**
   * Check if a token has potential for 2x or better
   */
  private isPotentialRunner(analysis: AnalysisResult): boolean {
    const { overallScore, confidence, technical, fundamental } = analysis;

    // Strong buy with high confidence
    if (overallScore >= 70 && confidence >= 0.7) return true;

    // Buy with very high confidence
    if (overallScore >= 60 && confidence >= 0.75) return true;

    // Volume breakout with good fundamentals
    if (technical.volumeBreakout && fundamental.liquidityLocked && overallScore >= 60) return true;

    // Smart money detected with decent score
    if (analysis.walletSignals && analysis.walletSignals.some(w => w.isSmartMoney) && overallScore >= 55) return true;

    return false;
  }

  /**
   * Start automated paper trading - finds tokens every 2 minutes or less
   */
  startAutomatedPaperTrading(): void {
    if (this.paperTradeInterval) {
      logger.warn('Automated paper trading already running');
      return;
    }

    logger.info('🤖 Starting automated paper trading');

    // Run every 2 minutes (120000ms)
    this.paperTradeInterval = setInterval(async () => {
      try {
        logger.info('🔍 Automated paper trade scan starting...');
        await this.scan();
      } catch (error) {
        logger.error('Error in automated paper trading:', error);
      }
    }, 120000);

    // Run initial scan immediately
    this.scan().catch(error => logger.error('Initial automated scan error:', error));
  }

  /**
   * Stop automated paper trading
   */
  stopAutomatedPaperTrading(): void {
    if (this.paperTradeInterval) {
      clearInterval(this.paperTradeInterval);
      this.paperTradeInterval = null;
      logger.info('Automated paper trading stopped');
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default new TokenScanner();
