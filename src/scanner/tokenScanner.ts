import { dexScreener, jupiter } from '../services/apiClients';
import tokenAnalyzer from '../analyzer/tokenAnalyzer';
import tradingEngine from '../trading/tradingEngine';
import patternLearner from '../learning/patternLearner';
import { config } from '../config';
import logger from '../utils/logger';
import { AnalysisResult } from '../types';
import db from '../database';

// Constants for Alpha picks and scoring
const ALPHA_SCORE_THRESHOLD = 29; // Score >= 29 is considered Alpha
const BUY_SIGNAL_SCORE_THRESHOLD = 30; // Score >= 30 triggers buy signal
const MOONSHOT_MULTIPLIER = 100; // 100x gain threshold

export class TokenScanner {
  private isScanning: boolean = false;
  private scanInterval: NodeJS.Timeout | null = null;
  private paperTradeInterval: NodeJS.Timeout | null = null;
  private mandatoryBuySignalInterval: NodeJS.Timeout | null = null;
  private alphaMonitorInterval: NodeJS.Timeout | null = null;
  private alertCallbacks: Array<(analysis: AnalysisResult) => void> = [];
  private scanNotifyCallbacks: Array<(tokenInfo: { address: string; name?: string; symbol?: string; score?: number; confidence?: number; isAlpha?: boolean }) => void> = [];
  private buySignalCallbacks: Array<(analysis: AnalysisResult) => void> = [];
  private forcedBuySignalCallbacks: Array<(analysis: AnalysisResult, reason: string) => void> = [];
  private alphaPickCallbacks: Array<(analysis: AnalysisResult, reason: string) => void> = [];
  private hundredXCallbacks: Array<(tokenData: any, pumpReason: string) => void> = [];
  private scannedTokens: Set<string> = new Set(); // Track scanned tokens to avoid duplicates
  private userScanIntervals: Map<number, NodeJS.Timeout> = new Map(); // Per-user scan intervals
  private userScannedTokens: Map<number, Set<string>> = new Map(); // Per-user scanned tokens
  private lastBuySignalTime: Date = new Date();
  private stats = {
    tokensScanned: 0,
    alertsTriggered: 0,
    buySignalsSent: 0,
    alphaPicks: 0,
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

    // Clear scanned tokens cache every 24 hours
    setInterval(() => {
      const previousSize = this.scannedTokens.size;
      this.scannedTokens.clear();
      logger.info(`🔄 Cleared scanned tokens cache (${previousSize} tokens removed)`);
    }, 86400000); // 24 hours

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
  onScanNotify(callback: (tokenInfo: { address: string; name?: string; symbol?: string; score?: number; confidence?: number; isAlpha?: boolean }) => void): void {
    this.scanNotifyCallbacks.push(callback);
  }

  /**
   * Register callback for alpha picks
   */
  onAlphaPick(callback: (analysis: AnalysisResult, reason: string) => void): void {
    this.alphaPickCallbacks.push(callback);
  }

  /**
   * Register callback for 100x tokens
   */
  on100xToken(callback: (tokenData: any, pumpReason: string) => void): void {
    this.hundredXCallbacks.push(callback);
  }

  /**
   * Register callback for buy signals
   */
  onBuySignal(callback: (analysis: AnalysisResult) => void): void {
    this.buySignalCallbacks.push(callback);
  }

  /**
   * Register callback for forced/mandatory buy signals
   */
  onForcedBuySignal(callback: (analysis: AnalysisResult, reason: string) => void): void {
    this.forcedBuySignalCallbacks.push(callback);
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
    return {
      ...this.stats,
      uniqueTokensScanned: this.scannedTokens.size,
    };
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
        // Skip if already scanned
        if (this.scannedTokens.has(tokenAddress)) {
          logger.info(`⏭️ Skipping ${tokenAddress} - already scanned`);
          continue;
        }

        // Mark as scanned
        this.scannedTokens.add(tokenAddress);

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
  private async analyzeAndAct(contractAddress: string, userId: number = 0): Promise<void> {
    try {
      const analysis = await tokenAnalyzer.analyzeToken(contractAddress);

      if (!analysis) return;

      // Check if this is an Alpha pick (score >= 29)
      const isAlpha = analysis.overallScore >= ALPHA_SCORE_THRESHOLD;
      const isBuySignal = analysis.overallScore >= BUY_SIGNAL_SCORE_THRESHOLD;

      logger.info(
        `${analysis.token.symbol}: Score ${analysis.overallScore.toFixed(0)}, ` +
        `Confidence ${(analysis.confidence * 100).toFixed(0)}%, ` +
        `Recommendation: ${analysis.recommendation}` +
        `${isAlpha ? ' ⭐ ALPHA' : ''}`
      );

      // Save scanned token for mandatory buy signal logic
      db.saveScannedToken({
        contractAddress: analysis.token.contractAddress,
        symbol: analysis.token.symbol,
        name: analysis.token.name,
        score: analysis.overallScore,
        confidence: analysis.confidence,
        recommendation: analysis.recommendation,
      });

      // If it's an Alpha pick, save to alpha_picks table
      if (isAlpha) {
        const alphaReason = this.generateAlphaReason(analysis);
        db.saveAlphaPick({
          contractAddress: analysis.token.contractAddress,
          symbol: analysis.token.symbol,
          name: analysis.token.name,
          initialScore: analysis.overallScore,
          initialPrice: analysis.token.price,
          alphaReason,
        });
        this.stats.alphaPicks++;
        logger.info(`⭐ ALPHA PICK: ${analysis.token.symbol} added with score ${analysis.overallScore.toFixed(0)}`);

        // Notify alpha pick callbacks
        this.sendAlphaPick(analysis, alphaReason);
      }

      // Notify with token info (name, symbol, score, isAlpha)
      this.notifyScan(
        contractAddress,
        analysis.token.name,
        analysis.token.symbol,
        analysis.overallScore,
        analysis.confidence,
        isAlpha
      );

      // Determine trade size based on confidence and alpha status
      const userSettings = db.getUserSettings(userId);
      const defaultTradeSize = userSettings?.defaultTradeSize || config.paperTrading.defaultTradeSize;
      const highConfidenceTradeSize = userSettings?.highConfidenceTradeSize || config.paperTrading.highConfidenceTradeSize;
      const highConfidenceThreshold = config.paperTrading.highConfidenceThreshold;

      // Use higher trade size for Alpha picks and high confidence tokens
      const isHighConfidence = (analysis.confidence >= highConfidenceThreshold && analysis.overallScore >= 70) || isAlpha;
      const tradeSize = isHighConfidence ? highConfidenceTradeSize : defaultTradeSize;

      // PAPER TRADE ALL SCANNED TOKENS (not just buy signals)
      // This allows us to learn from all patterns, including failed ones
      logger.info(`📝 Paper trading ${analysis.token.symbol} with ${tradeSize} SOL (${isAlpha ? 'ALPHA' : isHighConfidence ? 'HIGH CONFIDENCE' : 'standard'})...`);
      const position = await tradingEngine.buy(analysis, tradeSize, userId, true);

      if (position) {
        logger.info(`✅ Paper trade executed: ${position.amount.toFixed(2)} ${analysis.token.symbol} @ $${position.entryPrice.toFixed(8)}`);
      }

      // Send buy signal if score >= 30 (new threshold)
      if (isBuySignal) {
        logger.info(`🚨 BUY SIGNAL: ${analysis.token.symbol} score ${analysis.overallScore.toFixed(0)} >= ${BUY_SIGNAL_SCORE_THRESHOLD}!`);
        this.sendBuySignal(analysis);
        this.lastBuySignalTime = new Date();
        this.stats.buySignalsSent++;
        db.markBuySignalSent(analysis.token.contractAddress);
      }

      // Send alert to users for buy/strong_buy recommendations
      if (analysis.recommendation === 'strong_buy' || analysis.recommendation === 'buy' || isBuySignal) {
        this.sendAlert(analysis);

        // Auto-trade for users who have it enabled
        await this.handleAutoTrade(analysis);
      }
    } catch (error) {
      logger.error(`Error analyzing ${contractAddress}:`, error);
    }
  }

  /**
   * Generate reason why a token is an Alpha pick
   */
  private generateAlphaReason(analysis: AnalysisResult): string {
    const reasons: string[] = [];

    if (analysis.overallScore >= 50) reasons.push('High overall score');
    if (analysis.confidence >= 0.7) reasons.push('Strong confidence');
    if (analysis.technical.volumeBreakout) reasons.push('Volume breakout detected');
    if (analysis.fundamental.liquidityLocked) reasons.push('Liquidity locked');
    if (analysis.technical.priceAction === 'bullish') reasons.push('Bullish price action');
    if (analysis.fundamental.uniqueHolders > 500) reasons.push('Good holder count');
    if (analysis.walletSignals?.some(w => w.isSmartMoney)) reasons.push('Smart money detected');

    return reasons.length > 0 ? reasons.join(', ') : 'Score threshold met';
  }

  /**
   * Send alpha pick notification
   */
  private sendAlphaPick(analysis: AnalysisResult, reason: string): void {
    for (const callback of this.alphaPickCallbacks) {
      try {
        callback(analysis, reason);
      } catch (error) {
        logger.error('Error in alpha pick callback:', error);
      }
    }
  }

  /**
   * Handle auto-trading for all users with it enabled
   */
  private async handleAutoTrade(analysis: AnalysisResult): Promise<void> {
    // Get all users with auto-trade enabled and active subscriptions
    const autoTradeUsers = db.getAutoTradeSubscribers();

    if (autoTradeUsers.length === 0) {
      logger.debug('No users with auto-trade enabled');
      return;
    }

    logger.info(`Processing auto-trade for ${autoTradeUsers.length} users: ${analysis.token.symbol}`);

    for (const user of autoTradeUsers) {
      try {
        // Get full user settings for trade sizing
        const userSettings = db.getUserSettings(user.userId);
        if (!userSettings) continue;

        // Use paper trading setting from user
        const isPaperTrade = user.paperTrading;
        const tradeSize = analysis.confidence >= config.paperTrading.highConfidenceThreshold
          ? userSettings.highConfidenceTradeSize
          : userSettings.defaultTradeSize;

        logger.info(`Auto-trading for user ${user.userId} (${isPaperTrade ? 'PAPER' : 'REAL'}): ${analysis.token.symbol} @ ${tradeSize} SOL`);

        await tradingEngine.buy(analysis, tradeSize, user.userId, isPaperTrade);
      } catch (error) {
        logger.error(`Auto-trade error for user ${user.userId}:`, error);
      }
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
  private notifyScan(contractAddress: string, name?: string, symbol?: string, score?: number, confidence?: number, isAlpha?: boolean): void {
    for (const callback of this.scanNotifyCallbacks) {
      try {
        callback({ address: contractAddress, name, symbol, score, confidence, isAlpha });
      } catch (error) {
        logger.error('Error in scan notify callback:', error);
      }
    }
  }

  /**
   * Send forced buy signal (for mandatory 5-min signals)
   */
  private sendForcedBuySignal(analysis: AnalysisResult, reason: string): void {
    this.stats.buySignalsSent++;
    this.lastBuySignalTime = new Date();
    db.markBuySignalSent(analysis.token.contractAddress);

    for (const callback of this.forcedBuySignalCallbacks) {
      try {
        callback(analysis, reason);
      } catch (error) {
        logger.error('Error in forced buy signal callback:', error);
      }
    }

    // Also send regular buy signal
    this.sendBuySignal(analysis);
  }

  /**
   * Check and send mandatory buy signal if 5 minutes passed without one
   */
  private async checkMandatoryBuySignal(): Promise<void> {
    const now = new Date();
    const timeSinceLastSignal = now.getTime() - this.lastBuySignalTime.getTime();
    const mandatoryIntervalMs = config.scanner.mandatoryBuySignalIntervalMs || 300000; // 5 minutes

    if (timeSinceLastSignal >= mandatoryIntervalMs) {
      logger.info('🚨 5 minutes passed without buy signal - finding best token...');

      // Get best scanned token in last 5 minutes
      const bestToken = db.getBestScannedTokenSince(5);

      if (bestToken) {
        logger.info(`📈 Best token found: ${bestToken.symbol} (Score: ${bestToken.score})`);

        // Re-analyze the token for fresh data
        const analysis = await tokenAnalyzer.analyzeToken(bestToken.contract_address);

        if (analysis) {
          this.sendForcedBuySignal(analysis, 'Mandatory 5-minute signal - Best available token');
        }
      } else {
        logger.info('No suitable tokens found in last 5 minutes for mandatory signal');
      }
    }
  }

  /**
   * Start mandatory buy signal checker
   */
  startMandatoryBuySignalChecker(): void {
    if (this.mandatoryBuySignalInterval) {
      return;
    }

    // Check every minute
    this.mandatoryBuySignalInterval = setInterval(async () => {
      try {
        await this.checkMandatoryBuySignal();
      } catch (error) {
        logger.error('Error in mandatory buy signal checker:', error);
      }
    }, 60000); // 1 minute

    logger.info('🔔 Mandatory buy signal checker started (every 5 min)');
  }

  /**
   * Stop mandatory buy signal checker
   */
  stopMandatoryBuySignalChecker(): void {
    if (this.mandatoryBuySignalInterval) {
      clearInterval(this.mandatoryBuySignalInterval);
      this.mandatoryBuySignalInterval = null;
      logger.info('Mandatory buy signal checker stopped');
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

    // Clean old scanned tokens
    db.cleanOldScannedTokens();

    // Get scan interval (default 2 minutes = 120000ms)
    const scanIntervalMs = config.scanner.scanIntervalMs || 120000;

    // Run at configured interval
    this.paperTradeInterval = setInterval(async () => {
      try {
        logger.info('🔍 Automated paper trade scan starting...');
        await this.scan();
      } catch (error) {
        logger.error('Error in automated paper trading:', error);
      }
    }, scanIntervalMs);

    // Start mandatory buy signal checker (every 5 min)
    this.startMandatoryBuySignalChecker();

    // Run initial scan immediately
    this.scan().catch(error => logger.error('Initial automated scan error:', error));

    logger.info(`📊 Scanning every ${scanIntervalMs / 1000} seconds`);
    logger.info('🔔 Mandatory buy signal every 5 minutes enabled');
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

    this.stopMandatoryBuySignalChecker();
  }

  /**
   * Start scanning for a specific user (independent scanning)
   */
  startUserScanning(userId: number): boolean {
    if (this.userScanIntervals.has(userId)) {
      logger.warn(`User ${userId} already has scanning active`);
      return false;
    }

    // Initialize user's scanned tokens set
    if (!this.userScannedTokens.has(userId)) {
      this.userScannedTokens.set(userId, new Set());
    }

    // Mark user as scanning in DB
    db.startUserScanSession(userId);

    const scanIntervalMs = config.scanner.scanIntervalMs || 120000;

    // Create user-specific scan interval
    const interval = setInterval(async () => {
      try {
        await this.scanForUser(userId);
      } catch (error) {
        logger.error(`Error in user ${userId} scan:`, error);
      }
    }, scanIntervalMs);

    this.userScanIntervals.set(userId, interval);

    // Run initial scan
    this.scanForUser(userId).catch(error => logger.error(`Initial scan error for user ${userId}:`, error));

    logger.info(`🔍 Started independent scanning for user ${userId}`);
    return true;
  }

  /**
   * Stop scanning for a specific user
   */
  stopUserScanning(userId: number): boolean {
    const interval = this.userScanIntervals.get(userId);
    if (interval) {
      clearInterval(interval);
      this.userScanIntervals.delete(userId);
      db.stopUserScanSession(userId);
      logger.info(`🛑 Stopped scanning for user ${userId}`);
      return true;
    }
    return false;
  }

  /**
   * Check if a user is currently scanning
   */
  isUserScanning(userId: number): boolean {
    return this.userScanIntervals.has(userId) || db.isUserScanning(userId);
  }

  /**
   * Scan tokens for a specific user
   */
  private async scanForUser(userId: number): Promise<void> {
    try {
      logger.info(`🔍 Scanning for user ${userId}...`);

      const trendingTokens = await this.getTrendingTokens();
      const userScanned = this.userScannedTokens.get(userId) || new Set();

      for (const tokenAddress of trendingTokens) {
        // Skip if already scanned by this user
        if (userScanned.has(tokenAddress)) {
          continue;
        }

        userScanned.add(tokenAddress);
        db.incrementUserTokensScanned(userId);

        // Analyze and execute paper trade for this user
        await this.analyzeAndAct(tokenAddress, userId);
        this.stats.tokensScanned++;

        // Small delay to avoid rate limits
        await this.sleep(1000);
      }

      this.stats.lastScanTime = Date.now();
      logger.info(`✅ Scan complete for user ${userId}`);
    } catch (error) {
      logger.error(`Scan error for user ${userId}:`, error);
    }
  }

  /**
   * Get user scan statistics
   */
  getUserStats(userId: number): any {
    return db.getUserScanStats(userId);
  }

  /**
   * Start monitoring alpha picks for 100x gains
   */
  startAlphaMonitoring(): void {
    if (this.alphaMonitorInterval) {
      return;
    }

    // Check alpha picks every 5 minutes for price updates
    this.alphaMonitorInterval = setInterval(async () => {
      try {
        await this.monitorAlphaPicks();
      } catch (error) {
        logger.error('Error monitoring alpha picks:', error);
      }
    }, 300000); // 5 minutes

    logger.info('🔍 Alpha picks monitoring started');
  }

  /**
   * Stop monitoring alpha picks
   */
  stopAlphaMonitoring(): void {
    if (this.alphaMonitorInterval) {
      clearInterval(this.alphaMonitorInterval);
      this.alphaMonitorInterval = null;
      logger.info('Alpha picks monitoring stopped');
    }
  }

  /**
   * Monitor alpha picks for 100x gains
   */
  private async monitorAlphaPicks(): Promise<void> {
    const alphaPicks = db.getAlphaPicks(100);

    for (const pick of alphaPicks) {
      try {
        // Get current price
        const currentPrice = await jupiter.getTokenPrice(pick.contract_address);
        if (!currentPrice || currentPrice <= 0) continue;

        // Update price in database
        db.updateAlphaPickPrice(pick.contract_address, currentPrice);

        // Check for 100x
        if (pick.initial_price > 0) {
          const multiplier = currentPrice / pick.initial_price;

          if (multiplier >= MOONSHOT_MULTIPLIER && !pick.is_100x) {
            const pumpReason = await this.analyze100xPumpReason(pick, currentPrice, multiplier);

            // Mark as 100x and save pump reason
            db.mark100xToken(pick.contract_address, pumpReason);

            logger.info(`🚀🚀🚀 100X DETECTED: ${pick.symbol} went from $${pick.initial_price.toFixed(10)} to $${currentPrice.toFixed(10)} (${multiplier.toFixed(0)}x)!`);

            // Notify callbacks
            this.send100xNotification(pick, pumpReason);
          }
        }
      } catch (error) {
        logger.error(`Error monitoring alpha pick ${pick.symbol}:`, error);
      }
    }
  }

  /**
   * Analyze why a token pumped 100x
   */
  private async analyze100xPumpReason(pick: any, currentPrice: number, multiplier: number): Promise<string> {
    const reasons: string[] = [];

    // Get fresh analysis
    const analysis = await tokenAnalyzer.analyzeToken(pick.contract_address);

    if (analysis) {
      // Technical reasons
      if (analysis.technical.volumeBreakout) reasons.push('Massive volume breakout');
      if (analysis.technical.priceAction === 'bullish') reasons.push('Strong bullish momentum');

      // Fundamental reasons
      if (analysis.fundamental.uniqueHolders > 1000) reasons.push('Large holder base expansion');
      if (analysis.fundamental.liquidityLocked) reasons.push('Liquidity secured');

      // Smart money
      if (analysis.walletSignals?.some(w => w.isSmartMoney)) reasons.push('Smart money accumulation');

      // Social
      if (analysis.social.trendingScore > 0.7) reasons.push('Viral social momentum');
    }

    // Original alpha reason
    if (pick.alpha_reason) {
      reasons.push(`Initial alpha: ${pick.alpha_reason}`);
    }

    // Score range analysis
    reasons.push(`Initial score: ${pick.initial_score?.toFixed(0) || 'N/A'}`);
    reasons.push(`Peak multiplier: ${multiplier.toFixed(0)}x`);

    return reasons.join(' | ') || 'Unknown factors';
  }

  /**
   * Send 100x notification
   */
  private send100xNotification(tokenData: any, pumpReason: string): void {
    for (const callback of this.hundredXCallbacks) {
      try {
        callback(tokenData, pumpReason);
      } catch (error) {
        logger.error('Error in 100x callback:', error);
      }
    }
  }

  /**
   * Get alpha picks
   */
  getAlphaPicks(limit: number = 50): any[] {
    return db.getAlphaPicks(limit);
  }

  /**
   * Get 100x tokens
   */
  get100xTokens(): any[] {
    return db.get100xTokens();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default new TokenScanner();
