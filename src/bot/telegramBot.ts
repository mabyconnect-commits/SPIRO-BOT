import TelegramBot from 'node-telegram-bot-api';
import { config, TRADING_PRESETS } from '../config';
import tokenAnalyzer from '../analyzer/tokenAnalyzer';
import tradingEngine from '../trading/tradingEngine';
import tokenScanner from '../scanner/tokenScanner';
import patternLearner from '../learning/patternLearner';
import db from '../database';
import walletManager from '../services/walletManager';
import logger from '../utils/logger';
import { AnalysisResult } from '../types';

export class AlphaHunterBot {
  private bot: TelegramBot;
  private activeHunters: Map<number, boolean> = new Map(); // Track users who have hunt mode active

  constructor() {
    this.bot = new TelegramBot(config.telegram.botToken, { polling: true });
    this.setupErrorHandlers();
    this.setupCommands();
    this.setupMessageHandlers();
    this.setupAlerts();
    this.setupScanningUpdates();
  }

  private setupErrorHandlers(): void {
    // Handle polling errors
    this.bot.on('polling_error', (error) => {
      logger.error('Telegram polling error:', error);
    });

    // Handle webhook errors
    this.bot.on('webhook_error', (error) => {
      logger.error('Telegram webhook error:', error);
    });

    // Handle general errors
    this.bot.on('error', (error) => {
      logger.error('Telegram bot error:', error);
    });
  }

  private setupCommands(): void {
    // Command handlers
    this.bot.onText(/\/start/, this.handleStart.bind(this));
    this.bot.onText(/\/help/, this.handleHelp.bind(this));
    this.bot.onText(/\/hunt/, this.handleHunt.bind(this));
    this.bot.onText(/\/stop/, this.handleStop.bind(this));
    this.bot.onText(/\/scan (.+)/, this.handleScan.bind(this));
    this.bot.onText(/\/buy (.+)/, this.handleBuy.bind(this));
    this.bot.onText(/\/sell (.+)/, this.handleSell.bind(this));
    this.bot.onText(/\/portfolio/, this.handlePortfolio.bind(this));
    this.bot.onText(/\/preset(?:\s+(\w+))?/, this.handlePreset.bind(this));
    this.bot.onText(/\/settings/, this.handleSettings.bind(this));
    this.bot.onText(/\/patterns/, this.handlePatterns.bind(this));
    this.bot.onText(/\/learning/, this.handleLearning.bind(this));
    this.bot.onText(/\/autotrade(?:\s+(on|off))?/, this.handleAutoTrade.bind(this));
    this.bot.onText(/\/papermode(?:\s+(on|off))?/, this.handlePaperMode.bind(this));

    // Wallet commands
    this.bot.onText(/\/wallet/, this.handleWallet.bind(this));
    this.bot.onText(/\/createwallet/, this.handleCreateWallet.bind(this));
    this.bot.onText(/\/balance/, this.handleBalance.bind(this));
    this.bot.onText(/\/deposit/, this.handleDeposit.bind(this));

    logger.info('Telegram bot commands registered');
  }

  private setupMessageHandlers(): void {
    // Handle contract addresses pasted directly
    this.bot.on('message', async (msg) => {
      try {
        if (msg.text && !msg.text.startsWith('/')) {
          const text = msg.text.trim();

          logger.info(`Received message from user ${msg.from?.id}: ${text.substring(0, 50)}...`);

          // Check if it looks like a Solana contract address (32-44 characters, alphanumeric)
          if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) {
            logger.info('Detected contract address, analyzing...');
            await this.analyzeAndRespond(msg.chat.id, text);
          }
        }
      } catch (error) {
        logger.error('Error in message handler:', error);
        try {
          await this.bot.sendMessage(msg.chat.id, '❌ An error occurred processing your message.');
        } catch (sendError) {
          logger.error('Failed to send error message:', sendError);
        }
      }
    });

    // Handle callback queries from inline buttons
    this.bot.on('callback_query', async (query) => {
      try {
        const data = query.data;
        const chatId = query.message?.chat.id;

        if (!chatId || !data) return;

        logger.info(`Callback query from user ${query.from.id}: ${data}`);

        if (data.startsWith('buy:')) {
          const contractAddress = data.substring(4);
          await this.handleBuyCallback(chatId, contractAddress, query.from.id);
        } else if (data.startsWith('details:')) {
          const contractAddress = data.substring(8);
          await this.handleDetailsCallback(chatId, contractAddress);
        }

        // Answer the callback query to remove loading state
        await this.bot.answerCallbackQuery(query.id);
      } catch (error) {
        logger.error('Error in callback query handler:', error);
        if (query.id) {
          await this.bot.answerCallbackQuery(query.id, { text: '❌ An error occurred' });
        }
      }
    });
  }

  private setupAlerts(): void {
    tokenScanner.onAlert(async (analysis: AnalysisResult) => {
      // Send alert to all users with notifications enabled
      const message = this.formatAlert(analysis);

      // Send to all active hunters
      for (const [chatId, isActive] of this.activeHunters.entries()) {
        if (isActive) {
          try {
            await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
          } catch (error) {
            logger.error(`Failed to send alert to chat ${chatId}:`, error);
          }
        }
      }

      logger.info('Alert sent to active hunters');
    });
  }

  private setupScanningUpdates(): void {
    // Send periodic scanning updates to active hunters
    setInterval(async () => {
      if (this.activeHunters.size === 0) return;

      const isScanning = tokenScanner.isActive();
      if (!isScanning) return;

      // Get current scanning stats (you'll need to implement this in tokenScanner)
      const stats = tokenScanner.getStats();

      const updateMessage = `
🔍 *Scanning in Progress...*

Tokens scanned: ${stats.tokensScanned}
Alerts triggered: ${stats.alertsTriggered}
Last scan: ${new Date(stats.lastScanTime).toLocaleTimeString()}

Status: Active 🟢
      `;

      // Send update to all active hunters
      for (const [chatId, isActive] of this.activeHunters.entries()) {
        if (isActive) {
          try {
            // Only send every 5 minutes to avoid spam
            const shouldSend = Math.random() < 0.1; // 10% chance per interval
            if (shouldSend) {
              await this.bot.sendMessage(chatId, updateMessage, { parse_mode: 'Markdown' });
            }
          } catch (error) {
            logger.error(`Failed to send scanning update to chat ${chatId}:`, error);
          }
        }
      }
    }, 30000); // Check every 30 seconds
  }

  private async handleStart(msg: TelegramBot.Message): Promise<void> {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from?.id || 0;

      logger.info(`User ${userId} sent /start command`);

      // Create user if not exists
      db.createUser(userId);

      const welcome = `
🎯 *Welcome to Alpha Hunter!*

I'm your AI-powered Solana runner detection system. Here's what I can do:

🔍 *Scan & Analyze*
• Paste any contract address → Instant deep analysis
• /hunt → Start hunting for runners
• /scan \\[CA\\] → Analyze specific token

💰 *Trading*
• /buy \\[CA\\] → Buy a token (paper or real)
• /sell \\[position\\_id\\] → Close a position
• /portfolio → View your positions

⚙️ *Settings*
• /preset \\[name\\] → Change trading preset
• /autotrade on/off → Toggle auto-trading
• /papermode on/off → Toggle paper trading
• /settings → View your settings

📊 *Learning*
• /patterns → View pattern performance
• /learning → AI learning report

Type /help for more info or paste a contract address to start!
      `;

      await this.bot.sendMessage(chatId, welcome, { parse_mode: 'Markdown' });
      logger.info(`Successfully sent welcome message to user ${userId}`);
    } catch (error) {
      logger.error('Error in handleStart:', error);
      try {
        await this.bot.sendMessage(msg.chat.id, '❌ An error occurred. Please try again.');
      } catch (sendError) {
        logger.error('Failed to send error message:', sendError);
      }
    }
  }

  private async handleHelp(msg: TelegramBot.Message): Promise<void> {
    try {
      logger.info(`User ${msg.from?.id} requested help`);

      const help = `
📚 *Alpha Hunter Commands*

*Analysis:*
• Paste CA → Instant analysis
• /scan \\[CA\\] → Deep token analysis
• /hunt → Start auto-hunting
• /stop → Stop hunting

*Trading:*
• /buy \\[CA\\] \\[amount\\] → Buy token
• /sell \\[position\\] → Sell position
• /portfolio → View positions

*Presets:*
• /preset → Show current preset
• /preset conservative → Low risk
• /preset moderate → Medium risk
• /preset balanced → Default
• /preset aggressive → High risk
• /preset degen → YOLO mode

*Settings:*
• /autotrade on/off → Auto-trade signals
• /papermode on/off → Paper vs real
• /settings → View all settings

*Learning:*
• /patterns → Pattern performance
• /learning → AI learning stats

Ready to hunt some runners! 🚀
      `;

      await this.bot.sendMessage(msg.chat.id, help, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('Error in handleHelp:', error);
      try {
        await this.bot.sendMessage(msg.chat.id, '❌ An error occurred. Please try again.');
      } catch (sendError) {
        logger.error('Failed to send error message:', sendError);
      }
    }
  }

  private async handleHunt(msg: TelegramBot.Message): Promise<void> {
    try {
      const chatId = msg.chat.id;

      // Add user to active hunters
      this.activeHunters.set(chatId, true);

      // Start scanner if not already running
      if (!tokenScanner.isActive()) {
        tokenScanner.start();
      }

      await this.bot.sendMessage(
        chatId,
        '🔍 *Hunt mode activated!*\n\nScanning for runners... I\'ll send you:\n• Real-time token discoveries\n• High-confidence alerts\n• Scanning progress updates\n\nUse /stop to deactivate 🎯',
        { parse_mode: 'Markdown' }
      );

      // Send initial scanning status
      const stats = tokenScanner.getStats();
      const statusMessage = `
📊 *Current Scanning Status*

Tokens scanned today: ${stats.tokensScanned}
Alerts triggered: ${stats.alertsTriggered}
Scanner: Active 🟢

I'm watching the blockchain for you! 👀
      `;

      await this.bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });

      logger.info(`User ${msg.from?.id} activated hunt mode`);
    } catch (error) {
      logger.error('Error in handleHunt:', error);
      await this.bot.sendMessage(msg.chat.id, '❌ An error occurred. Please try again.');
    }
  }

  private async handleStop(msg: TelegramBot.Message): Promise<void> {
    try {
      const chatId = msg.chat.id;

      // Remove user from active hunters
      this.activeHunters.set(chatId, false);

      // Check if any hunters are still active
      const anyActive = Array.from(this.activeHunters.values()).some(active => active);
      if (!anyActive) {
        tokenScanner.stop();
      }

      const stats = tokenScanner.getStats();
      const message = `
🛑 *Hunt mode stopped*

Session Summary:
• Tokens scanned: ${stats.tokensScanned}
• Alerts sent: ${stats.alertsTriggered}

Use /hunt to start hunting again!
      `;

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });

      logger.info(`User ${msg.from?.id} stopped hunt mode`);
    } catch (error) {
      logger.error('Error in handleStop:', error);
      await this.bot.sendMessage(msg.chat.id, '❌ An error occurred. Please try again.');
    }
  }

  private async handleScan(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    const chatId = msg.chat.id;
    const contractAddress = match?.[1]?.trim();

    if (!contractAddress) {
      await this.bot.sendMessage(chatId, 'Usage: /scan <contract_address>');
      return;
    }

    await this.analyzeAndRespond(chatId, contractAddress);
  }

  private async analyzeAndRespond(chatId: number, contractAddress: string): Promise<void> {
    await this.bot.sendMessage(chatId, '🔍 Analyzing token... This may take a moment.');

    const analysis = await tokenAnalyzer.analyzeToken(contractAddress);

    if (!analysis) {
      await this.bot.sendMessage(chatId, '❌ Failed to analyze token. Make sure the contract address is valid.');
      return;
    }

    const message = this.formatAnalysis(analysis);
    await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });

    // Show action buttons
    const keyboard = {
      inline_keyboard: [
        [
          { text: '💰 Buy', callback_data: `buy:${contractAddress}` },
          { text: '📊 Details', callback_data: `details:${contractAddress}` },
        ],
      ],
    };

    await this.bot.sendMessage(
      chatId,
      'What would you like to do?',
      { reply_markup: keyboard }
    );
  }

  private async handleBuy(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id || 0;
    const args = match?.[1]?.trim().split(' ');

    if (!args || args.length < 1) {
      await this.bot.sendMessage(chatId, 'Usage: /buy <contract_address> [sol_amount]');
      return;
    }

    const contractAddress = args[0];
    const solAmount = args[1] ? parseFloat(args[1]) : 1.0;

    await this.bot.sendMessage(chatId, '🔍 Analyzing and executing trade...');

    const analysis = await tokenAnalyzer.analyzeToken(contractAddress);

    if (!analysis) {
      await this.bot.sendMessage(chatId, '❌ Failed to analyze token.');
      return;
    }

    const userSettings = db.getUserSettings(userId);
    const paperTrade = userSettings?.paperTrading ?? true;

    const position = await tradingEngine.buy(analysis, solAmount, userId, paperTrade);

    if (!position) {
      await this.bot.sendMessage(chatId, '❌ Trade failed. Check confidence level and position limits.');
      return;
    }

    const tradeType = paperTrade ? 'PAPER' : 'REAL';
    await this.bot.sendMessage(
      chatId,
      `✅ **${tradeType} BUY**\n\n` +
      `${position.amount.toFixed(2)} ${position.symbol}\n` +
      `Entry: $${position.entryPrice.toFixed(8)}\n` +
      `Invested: ${position.solInvested} SOL`,
      { parse_mode: 'Markdown' }
    );
  }

  private async handleSell(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id || 0;
    const positionId = match?.[1]?.trim();

    if (!positionId) {
      await this.bot.sendMessage(chatId, 'Usage: /sell <position_id>\n\nUse /portfolio to see position IDs');
      return;
    }

    const positions = db.getOpenPositions(userId);
    const position = positions.find(p => p.id === positionId || p.symbol.toLowerCase() === positionId.toLowerCase());

    if (!position) {
      await this.bot.sendMessage(chatId, '❌ Position not found.');
      return;
    }

    await tradingEngine.updatePosition(position);

    const success = await tradingEngine.sell(position, position.type === 'paper');

    if (success) {
      const pnlEmoji = position.pnl > 0 ? '🟢' : '🔴';
      await this.bot.sendMessage(
        chatId,
        `✅ Position closed!\n\n` +
        `${position.symbol}\n` +
        `${pnlEmoji} PnL: ${position.pnl.toFixed(4)} SOL (${position.pnlPercentage.toFixed(2)}%)`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await this.bot.sendMessage(chatId, '❌ Failed to close position.');
    }
  }

  private async handlePortfolio(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id || 0;

    const summary = await tradingEngine.getPortfolioSummary(userId);
    await this.bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' });
  }

  private async handlePreset(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id || 0;
    const presetName = match?.[1]?.toLowerCase();

    if (!presetName) {
      // Show current preset and available options
      const userSettings = db.getUserSettings(userId);
      const currentPreset = userSettings?.preset || 'balanced';

      let message = `⚙️ **Current Preset:** ${currentPreset}\n\n**Available Presets:**\n\n`;

      for (const [key, preset] of Object.entries(TRADING_PRESETS)) {
        message += `**${key}** - ${preset.description}\n`;
        message += `• Position Size: ${preset.maxPositionSizeSol} SOL\n`;
        message += `• Take Profit: ${preset.takeProfitPercentage}%\n`;
        message += `• Stop Loss: ${preset.stopLossPercentage}%\n\n`;
      }

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      return;
    }

    if (!TRADING_PRESETS[presetName]) {
      await this.bot.sendMessage(chatId, '❌ Invalid preset. Use: conservative, moderate, balanced, aggressive, or degen');
      return;
    }

    db.updateUserSettings(userId, { preset: presetName });

    await this.bot.sendMessage(
      chatId,
      `✅ Preset changed to **${presetName}**!`,
      { parse_mode: 'Markdown' }
    );
  }

  private async handleSettings(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id || 0;

    const userSettings = db.getUserSettings(userId);

    if (!userSettings) {
      await this.bot.sendMessage(chatId, '❌ User not found. Send /start to initialize.');
      return;
    }

    const message = `
⚙️ **Your Settings**

• Preset: ${userSettings.preset}
• Paper Trading: ${userSettings.paperTrading ? 'ON' : 'OFF'}
• Auto-Trade: ${userSettings.autoTrade ? 'ON' : 'OFF'}
• Alert Threshold: ${(userSettings.alertThreshold * 100).toFixed(0)}%
• Notifications: ${userSettings.notificationsEnabled ? 'ON' : 'OFF'}
    `;

    await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  }

  private async handlePatterns(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    const patterns = patternLearner.getUpdatedPatterns();

    let message = '🎯 **Pattern Performance**\n\n';

    patterns.forEach(pattern => {
      if (pattern.sampleSize === 0) return;

      const winRateEmoji = pattern.successRate > 0.6 ? '🔥' : pattern.successRate < 0.4 ? '❄️' : '📊';

      message += `${winRateEmoji} **${pattern.name}**\n`;
      message += `• Trades: ${pattern.sampleSize}\n`;
      message += `• Win Rate: ${(pattern.successRate * 100).toFixed(1)}%\n`;
      message += `• Avg Return: ${pattern.avgReturn.toFixed(1)}%\n\n`;
    });

    await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  }

  private async handleLearning(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    const report = patternLearner.generateLearningReport();
    await this.bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
  }

  private async handleAutoTrade(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id || 0;
    const mode = match?.[1]?.toLowerCase();

    if (!mode) {
      const userSettings = db.getUserSettings(userId);
      const status = userSettings?.autoTrade ? 'ON' : 'OFF';
      await this.bot.sendMessage(chatId, `Auto-trade is currently **${status}**`, { parse_mode: 'Markdown' });
      return;
    }

    const autoTrade = mode === 'on';
    db.updateUserSettings(userId, { autoTrade });

    await this.bot.sendMessage(
      chatId,
      `✅ Auto-trade ${autoTrade ? 'enabled' : 'disabled'}!`,
      { parse_mode: 'Markdown' }
    );
  }

  private async handlePaperMode(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id || 0;
    const mode = match?.[1]?.toLowerCase();

    if (!mode) {
      const userSettings = db.getUserSettings(userId);
      const status = userSettings?.paperTrading ? 'ON' : 'OFF';
      await this.bot.sendMessage(chatId, `Paper trading is currently **${status}**`, { parse_mode: 'Markdown' });
      return;
    }

    const paperTrading = mode === 'on';
    db.updateUserSettings(userId, { paperTrading });

    await this.bot.sendMessage(
      chatId,
      `✅ Paper trading ${paperTrading ? 'enabled' : 'disabled'}!\n\n` +
      `${paperTrading ? '📝 Your trades will be simulated.' : '⚠️ Your trades will use REAL funds!'}`,
      { parse_mode: 'Markdown' }
    );
  }

  private async handleBuyCallback(chatId: number, contractAddress: string, userId: number): Promise<void> {
    try {
      await this.bot.sendMessage(chatId, '🔍 Analyzing token for purchase...');

      const analysis = await tokenAnalyzer.analyzeToken(contractAddress);

      if (!analysis) {
        await this.bot.sendMessage(chatId, '❌ Failed to analyze token.');
        return;
      }

      const userSettings = db.getUserSettings(userId);
      const paperTrade = userSettings?.paperTrading ?? true;
      const solAmount = 1.0; // Default amount

      const position = await tradingEngine.buy(analysis, solAmount, userId, paperTrade);

      if (!position) {
        await this.bot.sendMessage(chatId, '❌ Trade failed. Check confidence level and position limits.');
        return;
      }

      const tradeType = paperTrade ? 'PAPER' : 'REAL';
      await this.bot.sendMessage(
        chatId,
        `✅ *${tradeType} BUY*\n\n` +
        `${position.amount.toFixed(2)} ${position.symbol}\n` +
        `Entry: $${position.entryPrice.toFixed(8)}\n` +
        `Invested: ${position.solInvested} SOL`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      logger.error('Error in handleBuyCallback:', error);
      await this.bot.sendMessage(chatId, '❌ An error occurred while processing your purchase.');
    }
  }

  private async handleDetailsCallback(chatId: number, contractAddress: string): Promise<void> {
    try {
      await this.bot.sendMessage(chatId, '🔍 Fetching detailed analysis...');

      const analysis = await tokenAnalyzer.analyzeToken(contractAddress);

      if (!analysis) {
        await this.bot.sendMessage(chatId, '❌ Failed to fetch token details.');
        return;
      }

      // Format detailed information
      const details = `
📊 *Detailed Token Analysis*

*Contract:* \`${contractAddress}\`
*Symbol:* ${analysis.token.symbol}
*Name:* ${analysis.token.name}

*Overall Score:* ${analysis.overallScore.toFixed(1)}/100
*Confidence:* ${(analysis.confidence * 100).toFixed(1)}%
*Recommendation:* ${analysis.recommendation.toUpperCase().replace('_', ' ')}

*Price Information:*
• Current Price: $${analysis.token.price.toFixed(8)}
• Market Cap: $${analysis.token.marketCap.toLocaleString()}
• Liquidity: $${analysis.token.liquidity.toLocaleString()}
• 24h Volume: $${analysis.token.volume24h.toLocaleString()}

*Holder Analysis:*
• Total Holders: ${analysis.token.holders}
• Holder Concentration: ${(analysis.fundamental.holderConcentration * 100).toFixed(1)}%
• Top Holder %: ${(analysis.fundamental.topHolderPercentage * 100).toFixed(1)}%

*Technical Signals:*
• Price Action: ${analysis.technical.priceAction}
• Liquidity Score: ${analysis.technical.liquidityScore.toFixed(1)}/100
• Volume Breakout: ${analysis.technical.volumeBreakout ? 'Yes ✅' : 'No'}

*Pattern Matches:*
${analysis.matchedPatterns.map(p => `• ${p.name} (${(p.confidence * 100).toFixed(0)}%)`).join('\n')}

*Reasoning:*
${analysis.reasoning}
      `;

      await this.bot.sendMessage(chatId, details, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('Error in handleDetailsCallback:', error);
      await this.bot.sendMessage(chatId, '❌ An error occurred while fetching details.');
    }
  }

  private async handleWallet(msg: TelegramBot.Message): Promise<void> {
    try {
      const userId = msg.from?.id || 0;
      const chatId = msg.chat.id;

      if (!walletManager.hasWallet(userId)) {
        await this.bot.sendMessage(
          chatId,
          '👛 *No Wallet Found*\n\nYou don\'t have a wallet yet. Create one with /createwallet to start trading with real SOL!',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const address = walletManager.getWalletAddress(userId);
      const balance = await walletManager.getBalance(userId);

      const message = `
👛 *Your Trading Wallet*

*Address:*
\`${address}\`

*Balance:* ${balance.toFixed(4)} SOL

Use /deposit to fund your wallet
Use /balance to refresh balance
      `;

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('Error in handleWallet:', error);
      await this.bot.sendMessage(msg.chat.id, '❌ An error occurred. Please try again.');
    }
  }

  private async handleCreateWallet(msg: TelegramBot.Message): Promise<void> {
    try {
      const userId = msg.from?.id || 0;
      const chatId = msg.chat.id;

      await this.bot.sendMessage(chatId, '🔐 Creating your secure trading wallet...');

      const result = await walletManager.createWallet(userId);

      if (!result.created) {
        await this.bot.sendMessage(
          chatId,
          '👛 *You already have a wallet!*\n\nUse /wallet to view your wallet details.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const message = `
✅ *Wallet Created Successfully!*

*Your Address:*
\`${result.publicKey}\`

🔒 Your private key is encrypted and stored securely.

*Next Steps:*
1. Use /deposit to get deposit instructions
2. Fund your wallet with SOL
3. Turn off paper trading: /papermode off
4. Start trading with real funds!

⚠️ *Important:* Keep your wallet funded to execute trades. Minimum recommended: 0.1 SOL
      `;

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      logger.info(`Created wallet for user ${userId}: ${result.publicKey}`);
    } catch (error) {
      logger.error('Error in handleCreateWallet:', error);
      await this.bot.sendMessage(msg.chat.id, '❌ An error occurred while creating your wallet. Please try again.');
    }
  }

  private async handleBalance(msg: TelegramBot.Message): Promise<void> {
    try {
      const userId = msg.from?.id || 0;
      const chatId = msg.chat.id;

      if (!walletManager.hasWallet(userId)) {
        await this.bot.sendMessage(
          chatId,
          '❌ You don\'t have a wallet yet. Create one with /createwallet',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      await this.bot.sendMessage(chatId, '🔄 Checking balance...');

      const balance = await walletManager.getBalance(userId);
      const address = walletManager.getWalletAddress(userId);

      const message = `
💰 *Wallet Balance*

*Address:* \`${address}\`
*Balance:* ${balance.toFixed(4)} SOL

${balance < 0.1 ? '⚠️ Low balance! Consider depositing more SOL for trading.' : '✅ Wallet funded and ready to trade!'}
      `;

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('Error in handleBalance:', error);
      await this.bot.sendMessage(msg.chat.id, '❌ An error occurred while checking your balance.');
    }
  }

  private async handleDeposit(msg: TelegramBot.Message): Promise<void> {
    try {
      const userId = msg.from?.id || 0;
      const chatId = msg.chat.id;

      if (!walletManager.hasWallet(userId)) {
        await this.bot.sendMessage(
          chatId,
          '❌ You don\'t have a wallet yet. Create one with /createwallet first!',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const address = walletManager.getWalletAddress(userId);

      const message = `
📥 *Deposit SOL to Your Wallet*

Send SOL to this address:
\`${address}\`

*How to Deposit:*
1. Copy the address above
2. Open your Solana wallet (Phantom, Solflare, etc.)
3. Send SOL to this address
4. Wait for confirmation (usually under 1 minute)
5. Check balance with /balance

*Recommended Amount:*
• Minimum: 0.1 SOL
• Recommended: 0.5+ SOL for multiple trades

⚠️ *Important:*
• Only send SOL on Solana network
• Sending other tokens may result in loss
• Start with small amounts to test
      `;

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('Error in handleDeposit:', error);
      await this.bot.sendMessage(msg.chat.id, '❌ An error occurred. Please try again.');
    }
  }

  private formatAnalysis(analysis: AnalysisResult): string {
    const { token, overallScore, confidence, recommendation, matchedPatterns, reasoning } = analysis;

    const recEmoji = {
      strong_buy: '🚀',
      buy: '✅',
      hold: '⏸️',
      avoid: '❌',
    };

    let message = `${recEmoji[recommendation]} **${recommendation.toUpperCase().replace('_', ' ')}**\n\n`;
    message += reasoning;

    return message;
  }

  private formatAlert(analysis: AnalysisResult): string {
    return `
🚨 **RUNNER ALERT!**

${analysis.token.symbol} - ${analysis.token.name}
Score: ${analysis.overallScore.toFixed(0)}/100
Confidence: ${(analysis.confidence * 100).toFixed(0)}%

${analysis.reasoning}

Use /scan ${analysis.token.contractAddress} for full analysis
    `;
  }

  async start(): Promise<void> {
    try {
      // Register bot commands with Telegram
      await this.bot.setMyCommands([
        { command: 'start', description: 'Start the bot and see welcome message' },
        { command: 'help', description: 'Show all available commands' },
        { command: 'hunt', description: 'Start hunting for runners' },
        { command: 'stop', description: 'Stop hunting' },
        { command: 'scan', description: 'Analyze a specific token' },
        { command: 'buy', description: 'Buy a token' },
        { command: 'sell', description: 'Close a position' },
        { command: 'portfolio', description: 'View your positions' },
        { command: 'preset', description: 'View or change trading preset' },
        { command: 'settings', description: 'View your settings' },
        { command: 'patterns', description: 'View pattern performance' },
        { command: 'learning', description: 'View AI learning report' },
        { command: 'autotrade', description: 'Toggle auto-trading' },
        { command: 'papermode', description: 'Toggle paper trading' },
        { command: 'wallet', description: 'View your trading wallet' },
        { command: 'createwallet', description: 'Create a new trading wallet' },
        { command: 'balance', description: 'Check your wallet balance' },
        { command: 'deposit', description: 'Get deposit instructions' },
      ]);

      logger.info('✅ Bot commands registered with Telegram');
      logger.info('🤖 Telegram bot started');
      logger.info('🚀 Alpha Hunter is online and ready to respond to messages!');
    } catch (error) {
      logger.error('Error registering bot commands:', error);
      logger.info('🤖 Telegram bot started (commands registration failed)');
    }
  }
}

export default AlphaHunterBot;
