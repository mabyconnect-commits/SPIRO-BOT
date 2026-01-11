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
   * Execute paper trading buy
   */
  private async executePaperBuy(
    analysis: AnalysisResult,
    solAmount: number,
    userId: number
  ): Promise<TradePosition> {
    const tokenPrice = analysis.token.price;
    const tokenAmount = (solAmount / tokenPrice) * 0.99; // Account for slippage

    const position: TradePosition = {
      id: crypto.randomUUID(),
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

    logger.info(
      `📝 PAPER BUY: ${solAmount} SOL → ${tokenAmount.toFixed(2)} ${analysis.token.symbol} @ $${tokenPrice.toFixed(8)}`
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
    if (!this.wallet) {
      logger.error('No wallet configured for real trading');
      return null;
    }

    try {
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
        this.wallet.publicKey.toString()
      );

      if (!swapResult || !swapResult.swapTransaction) {
        logger.error('Failed to get swap transaction');
        return null;
      }

      // Deserialize and sign transaction
      const transactionBuf = Buffer.from(swapResult.swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(transactionBuf);
      transaction.sign([this.wallet]);

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
   * Execute a sell order
   */
  async sell(
    position: TradePosition,
    paperTrade: boolean = config.trading.paperTrading
  ): Promise<boolean> {
    try {
      if (paperTrade || position.type === 'paper') {
        return this.executePaperSell(position);
      } else {
        return this.executeRealSell(position);
      }
    } catch (error) {
      logger.error('Sell error:', error);
      return false;
    }
  }

  /**
   * Execute paper trading sell
   */
  private async executePaperSell(position: TradePosition): Promise<boolean> {
    position.status = 'closed';
    position.closedAt = new Date();

    db.savePosition(position);

    const pnlEmoji = position.pnl > 0 ? '🟢' : '🔴';
    logger.info(
      `📝 PAPER SELL: ${position.amount.toFixed(2)} ${position.symbol} @ $${position.currentPrice.toFixed(8)} | ` +
      `${pnlEmoji} PnL: ${position.pnl.toFixed(4)} SOL (${position.pnlPercentage.toFixed(2)}%)`
    );

    return true;
  }

  /**
   * Execute real trading sell via Jupiter
   */
  private async executeRealSell(position: TradePosition): Promise<boolean> {
    if (!this.wallet) {
      logger.error('No wallet configured for real trading');
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
        this.wallet.publicKey.toString()
      );

      if (!swapResult || !swapResult.swapTransaction) {
        logger.error('Failed to get sell swap transaction');
        return false;
      }

      // Sign and send
      const transactionBuf = Buffer.from(swapResult.swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(transactionBuf);
      transaction.sign([this.wallet]);

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

      if (currentPrice > 0) {
        position.currentPrice = currentPrice;

        const currentValue = position.amount * currentPrice;
        const investedValue = position.solInvested;

        position.pnl = currentValue - investedValue;
        position.pnlPercentage = ((currentValue - investedValue) / investedValue) * 100;

        db.savePosition(position);
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

    if (positions.length === 0) {
      return '📊 No open positions';
    }

    let summary = `📊 **Portfolio (${positions.length} positions)**\n\n`;

    let totalInvested = 0;
    let totalValue = 0;

    for (const position of positions) {
      await this.updatePosition(position);

      const pnlEmoji = position.pnl > 0 ? '🟢' : '🔴';
      summary += `**${position.symbol}**\n`;
      summary += `• Entry: $${position.entryPrice.toFixed(8)}\n`;
      summary += `• Current: $${position.currentPrice.toFixed(8)}\n`;
      summary += `• ${pnlEmoji} PnL: ${position.pnlPercentage.toFixed(2)}%\n\n`;

      totalInvested += position.solInvested;
      totalValue += position.amount * position.currentPrice;
    }

    const totalPnl = totalValue - totalInvested;
    const totalPnlPercentage = (totalPnl / totalInvested) * 100;

    summary += `\n💰 **Total**\n`;
    summary += `• Invested: ${totalInvested.toFixed(2)} SOL\n`;
    summary += `• Value: ${totalValue.toFixed(2)} SOL\n`;
    summary += `• PnL: ${totalPnl.toFixed(2)} SOL (${totalPnlPercentage.toFixed(2)}%)\n`;

    return summary;
  }
}

export default new TradingEngine();
