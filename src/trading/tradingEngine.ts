import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { config, TRADING_PRESETS } from '../config';
import { TradePosition, TradingPreset, AnalysisResult } from '../types';
import { jupiter } from '../services/apiClients';
import db from '../database';
import logger from '../utils/logger';
import bs58 from 'bs58';
import crypto from 'crypto';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS_PER_SOL = 1_000_000_000;

// ============================================================
// TIERED TAKE PROFIT CONFIGURATION
// ============================================================
export interface TakeProfitTier {
  multiplier: number;      // Price multiplier (e.g., 2 = 2x)
  sellPercentage: number;  // Percentage of position to sell (e.g., 25 = 25%)
  triggered: boolean;      // Has this tier been triggered
}

export interface TrailingStopConfig {
  enabled: boolean;
  activationMultiplier: number;  // Activate trailing stop at this multiplier (e.g., 1.5 = 50% gain)
  trailingPercentage: number;    // Trail by this percentage (e.g., 20 = 20%)
  highWaterMark: number;         // Highest price seen since activation
  stopPrice: number;             // Current trailing stop price
  isActive: boolean;             // Has trailing stop been activated
}

export interface AdvancedPositionConfig {
  takeProfitTiers: TakeProfitTier[];
  trailingStop: TrailingStopConfig;
  remainingPercentage: number;   // Percentage of original position remaining
}

// Default tiered take profit strategy
const DEFAULT_TAKE_PROFIT_TIERS: TakeProfitTier[] = [
  { multiplier: 2, sellPercentage: 25, triggered: false },   // Sell 25% at 2x
  { multiplier: 5, sellPercentage: 25, triggered: false },   // Sell 25% at 5x
  { multiplier: 10, sellPercentage: 25, triggered: false },  // Sell 25% at 10x
  // Remaining 25% held for potential 100x (or trailing stop)
];

// Default trailing stop config
const DEFAULT_TRAILING_STOP: TrailingStopConfig = {
  enabled: true,
  activationMultiplier: 1.5,  // Activate after 50% gain
  trailingPercentage: 25,     // 25% trailing stop
  highWaterMark: 0,
  stopPrice: 0,
  isActive: false,
};

export class TradingEngine {
  private connection: Connection;
  private wallet: Keypair | null = null;
  private advancedPositionConfigs: Map<string, AdvancedPositionConfig> = new Map();

  constructor() {
    this.connection = new Connection(config.solana.rpcUrl, 'confirmed');

    if (config.solana.walletPrivateKey && !config.trading.paperTrading) {
      try {
        const privateKeyBytes = bs58.decode(config.solana.walletPrivateKey);
        this.wallet = Keypair.fromSecretKey(privateKeyBytes);
        logger.info(`Trading wallet initialized: ${this.wallet.publicKey.toString()}`);
      } catch (error) {
        logger.error('Failed to initialize wallet:', error);
      }
    }

    // Load advanced position configs from database
    this.loadAdvancedConfigs();
  }

  /**
   * Load advanced position configs from database
   */
  private loadAdvancedConfigs(): void {
    try {
      const configs = db.getAdvancedPositionConfigs();
      for (const config of configs) {
        this.advancedPositionConfigs.set(config.positionId, JSON.parse(config.config));
      }
      logger.debug(`Loaded ${this.advancedPositionConfigs.size} advanced position configs`);
    } catch (error) {
      logger.debug('Could not load advanced configs (table may not exist yet)');
    }
  }

  /**
   * Initialize advanced trading features for a position
   */
  initializeAdvancedTrading(
    positionId: string,
    entryPrice: number,
    customTiers?: TakeProfitTier[],
    customTrailingStop?: Partial<TrailingStopConfig>
  ): AdvancedPositionConfig {
    const config: AdvancedPositionConfig = {
      takeProfitTiers: customTiers || JSON.parse(JSON.stringify(DEFAULT_TAKE_PROFIT_TIERS)),
      trailingStop: {
        ...DEFAULT_TRAILING_STOP,
        ...customTrailingStop,
        highWaterMark: entryPrice,
        stopPrice: entryPrice * (1 - DEFAULT_TRAILING_STOP.trailingPercentage / 100),
      },
      remainingPercentage: 100,
    };

    this.advancedPositionConfigs.set(positionId, config);
    this.saveAdvancedConfig(positionId, config);

    logger.info(`📊 Advanced trading initialized for position ${positionId}`);
    logger.info(`   Take profit tiers: ${config.takeProfitTiers.map(t => `${t.multiplier}x (${t.sellPercentage}%)`).join(', ')}`);
    logger.info(`   Trailing stop: ${config.trailingStop.enabled ? `${config.trailingStop.trailingPercentage}% after ${config.trailingStop.activationMultiplier}x` : 'Disabled'}`);

    return config;
  }

  /**
   * Save advanced config to database
   */
  private saveAdvancedConfig(positionId: string, config: AdvancedPositionConfig): void {
    try {
      db.saveAdvancedPositionConfig(positionId, JSON.stringify(config));
    } catch (error) {
      logger.debug('Could not save advanced config (table may not exist)');
    }
  }

  /**
   * Process tiered take profit and trailing stop for a position
   * Returns list of actions taken (partial sells, trailing stop triggers)
   */
  async processAdvancedOrders(
    position: TradePosition,
    userId: number = 0
  ): Promise<{ action: string; amount: number; price: number }[]> {
    const actions: { action: string; amount: number; price: number }[] = [];
    const config = this.advancedPositionConfigs.get(position.id);

    if (!config) {
      return actions;
    }

    const currentMultiplier = position.currentPrice / position.entryPrice;

    // Process tiered take profits
    for (const tier of config.takeProfitTiers) {
      if (!tier.triggered && currentMultiplier >= tier.multiplier) {
        const sellAmount = (tier.sellPercentage / 100) * position.amount * (config.remainingPercentage / 100);

        if (sellAmount > 0) {
          // Execute partial sell
          const success = await this.executePartialSell(position, sellAmount, userId);

          if (success) {
            tier.triggered = true;
            config.remainingPercentage -= tier.sellPercentage;

            actions.push({
              action: `take_profit_${tier.multiplier}x`,
              amount: sellAmount,
              price: position.currentPrice,
            });

            logger.info(
              `🎯 TIERED TP: ${position.symbol} hit ${tier.multiplier}x! ` +
              `Sold ${tier.sellPercentage}% (${sellAmount.toFixed(4)} tokens) @ $${position.currentPrice.toFixed(8)}`
            );
          }
        }
      }
    }

    // Process trailing stop
    if (config.trailingStop.enabled) {
      const result = this.processTrailingStop(position, config, currentMultiplier);

      if (result.updated) {
        logger.info(
          `📈 Trailing stop updated for ${position.symbol}: ` +
          `High: $${config.trailingStop.highWaterMark.toFixed(8)}, Stop: $${config.trailingStop.stopPrice.toFixed(8)}`
        );
      }

      if (result.triggered) {
        // Execute trailing stop (sell remaining position)
        const remainingAmount = position.amount * (config.remainingPercentage / 100);
        const success = await this.executePartialSell(position, remainingAmount, userId);

        if (success) {
          actions.push({
            action: 'trailing_stop',
            amount: remainingAmount,
            price: position.currentPrice,
          });

          logger.info(
            `🛑 TRAILING STOP: ${position.symbol} triggered @ $${position.currentPrice.toFixed(8)} ` +
            `(Stop was $${config.trailingStop.stopPrice.toFixed(8)})`
          );
        }
      }
    }

    // Save updated config
    this.saveAdvancedConfig(position.id, config);

    return actions;
  }

  /**
   * Process trailing stop logic
   */
  private processTrailingStop(
    position: TradePosition,
    config: AdvancedPositionConfig,
    currentMultiplier: number
  ): { updated: boolean; triggered: boolean } {
    const result = { updated: false, triggered: false };
    const trailingStop = config.trailingStop;

    // Activate trailing stop if not active and multiplier threshold met
    if (!trailingStop.isActive && currentMultiplier >= trailingStop.activationMultiplier) {
      trailingStop.isActive = true;
      trailingStop.highWaterMark = position.currentPrice;
      trailingStop.stopPrice = position.currentPrice * (1 - trailingStop.trailingPercentage / 100);
      result.updated = true;

      logger.info(
        `🔔 Trailing stop ACTIVATED for ${position.symbol} at ${currentMultiplier.toFixed(2)}x ` +
        `(threshold: ${trailingStop.activationMultiplier}x)`
      );
    }

    // Update high water mark and stop price if trailing stop is active
    if (trailingStop.isActive) {
      if (position.currentPrice > trailingStop.highWaterMark) {
        trailingStop.highWaterMark = position.currentPrice;
        trailingStop.stopPrice = position.currentPrice * (1 - trailingStop.trailingPercentage / 100);
        result.updated = true;
      }

      // Check if trailing stop triggered
      if (position.currentPrice <= trailingStop.stopPrice) {
        result.triggered = true;
      }
    }

    return result;
  }

  /**
   * Execute partial sell (for tiered TP or trailing stop)
   */
  async executePartialSell(
    position: TradePosition,
    sellAmount: number,
    userId: number = 0
  ): Promise<boolean> {
    try {
      const isPaperTrade = position.type === 'paper';

      if (isPaperTrade) {
        return this.executePaperPartialSell(position, sellAmount, userId);
      } else {
        return this.executeRealPartialSell(position, sellAmount, userId);
      }
    } catch (error) {
      logger.error('Partial sell error:', error);
      return false;
    }
  }

  /**
   * Execute paper partial sell
   */
  private async executePaperPartialSell(
    position: TradePosition,
    sellAmount: number,
    userId: number
  ): Promise<boolean> {
    // Calculate value of sold tokens
    const soldValue = sellAmount * position.currentPrice;

    // Get current balance and add sold value
    const currentBalance = db.getPaperBalance(userId);
    const newBalance = currentBalance + soldValue;
    db.updatePaperBalance(userId, newBalance);

    // Update position amount
    position.amount -= sellAmount;

    // Calculate proportional SOL invested reduction
    const sellPercentage = sellAmount / (position.amount + sellAmount);
    const solReturned = position.solInvested * sellPercentage;
    position.solInvested -= solReturned;

    // Save updated position
    db.savePosition(position);

    // Record in history
    db.recordPaperTradeHistory({
      userId,
      positionId: position.id,
      contractAddress: position.contractAddress,
      symbol: position.symbol,
      action: 'partial_sell',
      amountSol: soldValue,
      tokenAmount: sellAmount,
      price: position.currentPrice,
      paperBalanceBefore: currentBalance,
      paperBalanceAfter: newBalance,
      pnl: soldValue - solReturned,
      pnlPercentage: ((soldValue - solReturned) / solReturned) * 100,
    });

    const pnl = soldValue - solReturned;
    const pnlEmoji = pnl > 0 ? '🟢' : '🔴';

    logger.info(
      `📝 PAPER PARTIAL SELL: ${sellAmount.toFixed(4)} ${position.symbol} @ $${position.currentPrice.toFixed(8)} | ` +
      `${pnlEmoji} PnL: ${pnl.toFixed(4)} SOL | Balance: ${newBalance.toFixed(4)} SOL | Remaining: ${position.amount.toFixed(4)} tokens`
    );

    return true;
  }

  /**
   * Execute real partial sell
   */
  private async executeRealPartialSell(
    position: TradePosition,
    sellAmount: number,
    userId: number
  ): Promise<boolean> {
    const userWallet = await this.getUserWallet(userId);
    if (!userWallet) {
      logger.error(`No wallet configured for user ${userId} for partial sell`);
      return false;
    }

    try {
      // Get quote from Jupiter for partial amount
      const tokenAmountInSmallestUnit = Math.floor(sellAmount * Math.pow(10, 9));
      const quote = await jupiter.getQuote(
        position.contractAddress,
        SOL_MINT,
        tokenAmountInSmallestUnit,
        config.trading.slippageBps
      );

      if (!quote) {
        logger.error('Failed to get Jupiter partial sell quote');
        return false;
      }

      // Get and execute swap
      const swapResult = await jupiter.getSwapTransaction(quote, userWallet.publicKey.toString());
      if (!swapResult?.swapTransaction) {
        logger.error('Failed to get partial sell swap transaction');
        return false;
      }

      const transactionBuf = Buffer.from(swapResult.swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(transactionBuf);
      transaction.sign([userWallet]);

      const signature = await this.connection.sendRawTransaction(
        transaction.serialize(),
        { skipPreflight: false, maxRetries: 3 }
      );

      const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
      if (confirmation.value.err) {
        logger.error('Partial sell transaction failed:', confirmation.value.err);
        return false;
      }

      // Update position
      position.amount -= sellAmount;
      const sellPercentage = sellAmount / (position.amount + sellAmount);
      position.solInvested -= position.solInvested * sellPercentage;
      db.savePosition(position);

      logger.info(
        `✅ REAL PARTIAL SELL: ${sellAmount.toFixed(4)} ${position.symbol} @ $${position.currentPrice.toFixed(8)}`
      );
      logger.info(`Transaction: https://solscan.io/tx/${signature}`);

      return true;
    } catch (error) {
      logger.error('Real partial sell execution error:', error);
      return false;
    }
  }

  /**
   * Get advanced position config for a position
   */
  getAdvancedConfig(positionId: string): AdvancedPositionConfig | undefined {
    return this.advancedPositionConfigs.get(positionId);
  }

  /**
   * Set custom take profit tiers for a position
   */
  setTakeProfitTiers(positionId: string, tiers: TakeProfitTier[]): boolean {
    const config = this.advancedPositionConfigs.get(positionId);
    if (!config) return false;

    config.takeProfitTiers = tiers;
    this.saveAdvancedConfig(positionId, config);
    return true;
  }

  /**
   * Set trailing stop config for a position
   */
  setTrailingStop(positionId: string, trailingConfig: Partial<TrailingStopConfig>): boolean {
    const config = this.advancedPositionConfigs.get(positionId);
    if (!config) return false;

    config.trailingStop = { ...config.trailingStop, ...trailingConfig };
    this.saveAdvancedConfig(positionId, config);
    return true;
  }

  /**
   * Disable advanced trading for a position (use simple TP/SL)
   */
  disableAdvancedTrading(positionId: string): void {
    this.advancedPositionConfigs.delete(positionId);
    try {
      db.deleteAdvancedPositionConfig(positionId);
    } catch {
      // Ignore if table doesn't exist
    }
  }

  /**
   * Get position status with advanced trading info
   */
  getAdvancedPositionStatus(position: TradePosition): string {
    const config = this.advancedPositionConfigs.get(position.id);
    if (!config) {
      return 'Standard TP/SL';
    }

    const currentMultiplier = position.currentPrice / position.entryPrice;
    const triggeredTiers = config.takeProfitTiers.filter(t => t.triggered).length;
    const totalTiers = config.takeProfitTiers.length;

    let status = `📊 Advanced Trading\n`;
    status += `• Multiplier: ${currentMultiplier.toFixed(2)}x\n`;
    status += `• TP Tiers: ${triggeredTiers}/${totalTiers} triggered\n`;
    status += `• Remaining: ${config.remainingPercentage}%\n`;

    if (config.trailingStop.isActive) {
      status += `• 🔔 Trailing Stop ACTIVE\n`;
      status += `  - High: $${config.trailingStop.highWaterMark.toFixed(8)}\n`;
      status += `  - Stop: $${config.trailingStop.stopPrice.toFixed(8)}\n`;
    } else if (config.trailingStop.enabled) {
      const activationPrice = position.entryPrice * config.trailingStop.activationMultiplier;
      status += `• Trailing Stop: Activates at $${activationPrice.toFixed(8)} (${config.trailingStop.activationMultiplier}x)\n`;
    }

    return status;
  }

  /**
   * Execute a buy order (real or paper)
   */
  async buy(
    analysis: AnalysisResult,
    solAmount: number,
    userId: number = 0,
    paperTrade: boolean = config.trading.paperTrading
  ): Promise<TradePosition | null> {
    try {
      const preset = this.getUserPreset(userId);

      // Check if we should trade based on confidence
      if (analysis.confidence < preset.minConfidence) {
        logger.info(
          `Skipping trade: confidence ${analysis.confidence.toFixed(2)} < minimum ${preset.minConfidence}`
        );
        return null;
      }

      // Check position limits
      const openPositions = db.getOpenPositions(userId);
      if (openPositions.length >= preset.maxOpenPositions) {
        logger.info(`Max open positions reached (${preset.maxOpenPositions})`);
        return null;
      }

      // Cap position size
      const cappedAmount = Math.min(solAmount, preset.maxPositionSizeSol);

      if (paperTrade) {
        return this.executePaperBuy(analysis, cappedAmount, userId);
      } else {
        return this.executeRealBuy(analysis, cappedAmount, userId);
      }
    } catch (error) {
      logger.error('Buy error:', error);
      return null;
    }
  }

  /**
   * Execute paper trading buy with balance tracking
   */
  private async executePaperBuy(
    analysis: AnalysisResult,
    solAmount: number,
    userId: number
  ): Promise<TradePosition | null> {
    // Get current paper balance
    const currentBalance = db.getPaperBalance(userId);

    // Check if user has enough balance
    if (currentBalance < solAmount) {
      logger.info(`❌ Insufficient paper balance: ${currentBalance.toFixed(4)} SOL < ${solAmount} SOL`);
      return null;
    }

    const tokenPrice = analysis.token.price;
    const tokenAmount = (solAmount / tokenPrice) * 0.99; // Account for slippage

    // Deduct from paper balance
    const newBalance = currentBalance - solAmount;
    db.updatePaperBalance(userId, newBalance);

    const position: TradePosition = {
      id: crypto.randomUUID(),
      userId: userId,
      contractAddress: analysis.token.contractAddress,
      symbol: analysis.token.symbol,
      entryPrice: tokenPrice,
      currentPrice: tokenPrice,
      amount: tokenAmount,
      solInvested: solAmount,
      pnl: 0,
      pnlPercentage: 0,
      openedAt: new Date(),
      status: 'open',
      type: 'paper',
    };

    db.savePosition(position);

    // Record in paper trade history
    db.recordPaperTradeHistory({
      userId,
      positionId: position.id,
      contractAddress: analysis.token.contractAddress,
      symbol: analysis.token.symbol,
      action: 'buy',
      amountSol: solAmount,
      tokenAmount,
      price: tokenPrice,
      paperBalanceBefore: currentBalance,
      paperBalanceAfter: newBalance,
      confidence: analysis.confidence,
    });

    logger.info(
      `📝 PAPER BUY: ${solAmount} SOL → ${tokenAmount.toFixed(2)} ${analysis.token.symbol} @ $${tokenPrice.toFixed(8)} | Balance: ${newBalance.toFixed(4)} SOL`
    );

    return position;
  }

  /**
   * Execute real trading buy via Jupiter
   */
  private async executeRealBuy(
    analysis: AnalysisResult,
    solAmount: number,
    userId: number
  ): Promise<TradePosition | null> {
    // Get user's wallet
    const userWallet = await this.getUserWallet(userId);
    if (!userWallet) {
      logger.error(`No wallet configured for user ${userId}`);
      return null;
    }

    try {
      // Check user's balance first
      const balance = await this.connection.getBalance(userWallet.publicKey);
      const balanceInSol = balance / LAMPORTS_PER_SOL;

      if (balanceInSol < solAmount + 0.01) { // 0.01 SOL for fees
        logger.error(`Insufficient balance for user ${userId}: ${balanceInSol.toFixed(4)} SOL < ${solAmount} SOL needed`);
        return null;
      }

      // Get quote from Jupiter
      const amountInLamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
      const quote = await jupiter.getQuote(
        SOL_MINT,
        analysis.token.contractAddress,
        amountInLamports,
        config.trading.slippageBps
      );

      if (!quote) {
        logger.error('Failed to get Jupiter quote');
        return null;
      }

      // Get swap transaction
      const swapResult = await jupiter.getSwapTransaction(
        quote,
        userWallet.publicKey.toString()
      );

      if (!swapResult || !swapResult.swapTransaction) {
        logger.error('Failed to get swap transaction');
        return null;
      }

      // Deserialize and sign transaction
      const transactionBuf = Buffer.from(swapResult.swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(transactionBuf);
      transaction.sign([userWallet]);

      // Send transaction
      const signature = await this.connection.sendRawTransaction(
        transaction.serialize(),
        {
          skipPreflight: false,
          maxRetries: 3,
        }
      );

      // Confirm transaction
      const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');

      if (confirmation.value.err) {
        logger.error('Transaction failed:', confirmation.value.err);
        return null;
      }

      const tokenPrice = analysis.token.price;
      const tokenAmount = parseFloat(quote.outAmount) / Math.pow(10, 9); // Adjust for decimals

      const position: TradePosition = {
        id: signature,
        userId: userId,
        contractAddress: analysis.token.contractAddress,
        symbol: analysis.token.symbol,
        entryPrice: tokenPrice,
        currentPrice: tokenPrice,
        amount: tokenAmount,
        solInvested: solAmount,
        pnl: 0,
        pnlPercentage: 0,
        openedAt: new Date(),
        status: 'open',
        type: 'real',
      };

      // Save position with user ID
      db.savePosition(position);

      logger.info(
        `✅ REAL BUY: ${solAmount} SOL → ${tokenAmount.toFixed(2)} ${analysis.token.symbol} @ $${tokenPrice.toFixed(8)}`
      );
      logger.info(`Transaction: https://solscan.io/tx/${signature}`);

      return position;
    } catch (error) {
      logger.error('Real buy execution error:', error);
      return null;
    }
  }

  /**
   * Get user's keypair for real trading
   */
  private async getUserWallet(userId: number): Promise<Keypair | null> {
    const walletData = db.getUserWallet(userId);
    if (!walletData) {
      return null;
    }

    try {
      // Decrypt and reconstruct keypair
      const decryptedKey = this.decryptPrivateKey(walletData.encryptedPrivateKey);
      const privateKeyBytes = new Uint8Array(JSON.parse(decryptedKey));
      return Keypair.fromSecretKey(privateKeyBytes);
    } catch (error) {
      logger.error(`Failed to get wallet for user ${userId}:`, error);
      return null;
    }
  }

  /**
   * Decrypt private key
   */
  private decryptPrivateKey(encryptedKey: string): string {
    const algorithm = 'aes-256-cbc';
    const key = crypto.scryptSync(config.security?.encryptionKey || 'default-key', 'salt', 32);
    const [ivHex, encrypted] = encryptedKey.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * Execute a sell order
   */
  async sell(
    position: TradePosition,
    paperTrade: boolean = config.trading.paperTrading,
    userId: number = 0
  ): Promise<boolean> {
    try {
      if (paperTrade || position.type === 'paper') {
        return this.executePaperSell(position, userId);
      } else {
        return this.executeRealSell(position, userId);
      }
    } catch (error) {
      logger.error('Sell error:', error);
      return false;
    }
  }

  /**
   * Execute paper trading sell with balance tracking
   */
  private async executePaperSell(position: TradePosition, userId: number = 0): Promise<boolean> {
    position.status = 'closed';
    position.closedAt = new Date();

    // Calculate current value and add back to paper balance
    const currentValue = position.amount * position.currentPrice;
    const currentBalance = db.getPaperBalance(userId);
    const newBalance = currentBalance + currentValue;

    // Update paper balance
    db.updatePaperBalance(userId, newBalance);

    db.savePosition(position);

    // Record in paper trade history
    db.recordPaperTradeHistory({
      userId,
      positionId: position.id,
      contractAddress: position.contractAddress,
      symbol: position.symbol,
      action: 'sell',
      amountSol: currentValue,
      tokenAmount: position.amount,
      price: position.currentPrice,
      paperBalanceBefore: currentBalance,
      paperBalanceAfter: newBalance,
      pnl: position.pnl,
      pnlPercentage: position.pnlPercentage,
    });

    const pnlEmoji = position.pnl > 0 ? '🟢' : '🔴';
    logger.info(
      `📝 PAPER SELL: ${position.amount.toFixed(2)} ${position.symbol} @ $${position.currentPrice.toFixed(8)} | ` +
      `${pnlEmoji} PnL: ${position.pnl.toFixed(4)} SOL (${position.pnlPercentage.toFixed(2)}%) | Balance: ${newBalance.toFixed(4)} SOL`
    );

    return true;
  }

  /**
   * Execute real trading sell via Jupiter
   */
  private async executeRealSell(position: TradePosition, userId: number = 0): Promise<boolean> {
    // Get user's wallet
    const userWallet = await this.getUserWallet(userId);
    if (!userWallet) {
      logger.error(`No wallet configured for user ${userId} for sell`);
      return false;
    }

    try {
      // Get quote from Jupiter (token → SOL)
      const tokenAmountInSmallestUnit = Math.floor(position.amount * Math.pow(10, 9));
      const quote = await jupiter.getQuote(
        position.contractAddress,
        SOL_MINT,
        tokenAmountInSmallestUnit,
        config.trading.slippageBps
      );

      if (!quote) {
        logger.error('Failed to get Jupiter sell quote');
        return false;
      }

      // Get swap transaction
      const swapResult = await jupiter.getSwapTransaction(
        quote,
        userWallet.publicKey.toString()
      );

      if (!swapResult || !swapResult.swapTransaction) {
        logger.error('Failed to get sell swap transaction');
        return false;
      }

      // Sign and send
      const transactionBuf = Buffer.from(swapResult.swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(transactionBuf);
      transaction.sign([userWallet]);

      const signature = await this.connection.sendRawTransaction(
        transaction.serialize(),
        { skipPreflight: false, maxRetries: 3 }
      );

      const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');

      if (confirmation.value.err) {
        logger.error('Sell transaction failed:', confirmation.value.err);
        return false;
      }

      position.status = 'closed';
      position.closedAt = new Date();
      db.savePosition(position);

      const pnlEmoji = position.pnl > 0 ? '🟢' : '🔴';
      logger.info(
        `✅ REAL SELL: ${position.amount.toFixed(2)} ${position.symbol} @ $${position.currentPrice.toFixed(8)} | ` +
        `${pnlEmoji} PnL: ${position.pnl.toFixed(4)} SOL (${position.pnlPercentage.toFixed(2)}%)`
      );
      logger.info(`Transaction: https://solscan.io/tx/${signature}`);

      return true;
    } catch (error) {
      logger.error('Real sell execution error:', error);
      return false;
    }
  }

  /**
   * Update position with current price and PnL
   */
  async updatePosition(position: TradePosition): Promise<TradePosition> {
    try {
      const currentPrice = await jupiter.getTokenPrice(position.contractAddress);

      if (currentPrice !== null && currentPrice > 0) {
        position.currentPrice = currentPrice;

        const currentValue = position.amount * currentPrice;
        const investedValue = position.solInvested;

        position.pnl = currentValue - investedValue;
        position.pnlPercentage = ((currentValue - investedValue) / investedValue) * 100;

        db.savePosition(position);
      } else if (currentPrice === null) {
        logger.warn(`Could not fetch price for position ${position.symbol} (${position.contractAddress})`);
      }

      return position;
    } catch (error) {
      logger.error('Error updating position:', error);
      return position;
    }
  }

  /**
   * Check if position should be closed based on take profit / stop loss
   */
  shouldClosePosition(position: TradePosition, userId: number = 0): boolean {
    const preset = this.getUserPreset(userId);

    // Take profit
    if (position.pnlPercentage >= preset.takeProfitPercentage) {
      logger.info(
        `🎯 Take profit triggered for ${position.symbol}: ${position.pnlPercentage.toFixed(2)}%`
      );
      return true;
    }

    // Stop loss
    if (position.pnlPercentage <= -preset.stopLossPercentage) {
      logger.info(
        `🛑 Stop loss triggered for ${position.symbol}: ${position.pnlPercentage.toFixed(2)}%`
      );
      return true;
    }

    return false;
  }

  private getUserPreset(userId: number): TradingPreset {
    const userSettings = db.getUserSettings(userId);
    const presetName = userSettings?.preset || config.trading.defaultPreset;
    return TRADING_PRESETS[presetName] || TRADING_PRESETS.balanced;
  }

  /**
   * Get portfolio summary
   */
  async getPortfolioSummary(userId: number = 0): Promise<string> {
    const positions = db.getOpenPositions(userId);
    const paperBalance = db.getPaperBalance(userId);

    let summary = `📊 **Portfolio Summary**\n\n`;
    summary += `💰 *Paper Balance:* ${paperBalance.toFixed(4)} SOL\n\n`;

    if (positions.length === 0) {
      summary += `📂 *Open Positions:* None\n`;
      return summary;
    }

    summary += `📂 *Open Positions (${positions.length}):*\n\n`;

    let totalInvested = 0;
    let totalValue = 0;

    for (const position of positions) {
      await this.updatePosition(position);

      const pnlEmoji = position.pnl > 0 ? '🟢' : position.pnl < 0 ? '🔴' : '⚪';
      summary += `**${position.symbol}** (${position.type.toUpperCase()})\n`;
      summary += `• Entry: $${position.entryPrice.toFixed(8)}\n`;
      summary += `• Current: $${position.currentPrice.toFixed(8)}\n`;
      summary += `• Invested: ${position.solInvested.toFixed(4)} SOL\n`;
      summary += `• ${pnlEmoji} PnL: ${position.pnl > 0 ? '+' : ''}${position.pnlPercentage.toFixed(2)}%\n\n`;

      totalInvested += position.solInvested;
      totalValue += position.amount * position.currentPrice;
    }

    const totalPnl = totalValue - totalInvested;
    const totalPnlPercentage = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

    const totalPnlEmoji = totalPnl > 0 ? '🟢' : totalPnl < 0 ? '🔴' : '⚪';

    summary += `\n💼 **Positions Total**\n`;
    summary += `• Invested: ${totalInvested.toFixed(4)} SOL\n`;
    summary += `• Current Value: ${totalValue.toFixed(4)} SOL\n`;
    summary += `• ${totalPnlEmoji} PnL: ${totalPnl > 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL (${totalPnlPercentage.toFixed(2)}%)\n\n`;

    summary += `📈 **Account Value:** ${(paperBalance + totalValue).toFixed(4)} SOL`;

    return summary;
  }

  /**
   * Get paper balance for a user
   */
  getPaperBalance(userId: number = 0): number {
    return db.getPaperBalance(userId);
  }

  /**
   * Reset paper balance to initial value
   */
  resetPaperBalance(userId: number = 0): void {
    const initialBalance = config.paperTrading?.initialBalance || 100;
    db.updatePaperBalance(userId, initialBalance);
    logger.info(`Paper balance reset to ${initialBalance} SOL for user ${userId}`);
  }
}

export default new TradingEngine();
