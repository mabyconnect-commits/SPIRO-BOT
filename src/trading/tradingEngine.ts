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

export class TradingEngine {
  private connection: Connection;
  private wallet: Keypair | null = null;

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
