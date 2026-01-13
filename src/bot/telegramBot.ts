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
  private pendingPinSetup: Map<number, { privateKey: string; action: string }> = new Map(); // Track pending PIN setups

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
          const userId = msg.from?.id || 0;

          logger.info(`Received message from user ${userId}: ${text.substring(0, 50)}...`);

          // Check if user is setting up a PIN
          if (this.pendingPinSetup.has(userId)) {
            // Validate PIN (4 digits)
            if (/^\d{4}$/.test(text)) {
              await this.handlePinSetup(msg.chat.id, userId, text);
              return;
            } else {
              await this.bot.sendMessage(msg.chat.id, '❌ Invalid PIN. Please enter exactly 4 digits.');
              return;
            }
          }

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
        } else if (data === 'export_private_key') {
          await this.handleExportPrivateKeyCallback(chatId, query.from.id);
        } else if (data === 'setup_pin') {
          await this.handleSetupPinCallback(chatId, query.from.id);
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
      // Send to all active hunters with animation
      for (const [chatId, isActive] of this.activeHunters.entries()) {
        if (isActive) {
          try {
            // Animated token found notification
            const alertMsg = await this.bot.sendMessage(
              chatId,
              '🎯 *Token Found!*\n\n⏳ Analyzing...',
              { parse_mode: 'Markdown' }
            );

            await this.sleep(1500);
            await this.bot.editMessageText(
              '🎯 *Token Found!*\n\n🔍 Deep scanning...',
              { chat_id: chatId, message_id: alertMsg.message_id, parse_mode: 'Markdown' }
            );

            await this.sleep(1500);
            await this.bot.editMessageText(
              '🎯 *Token Found!*\n\n📊 Calculating scores...',
              { chat_id: chatId, message_id: alertMsg.message_id, parse_mode: 'Markdown' }
            );

            await this.sleep(1000);
            await this.bot.editMessageText(
              '✅ *Analysis Complete!*\n\nScroll down for details 👇',
              { chat_id: chatId, message_id: alertMsg.message_id, parse_mode: 'Markdown' }
            );

            // Send the detailed analysis
            const message = this.formatAnalysis(analysis);
            await this.bot.sendMessage(chatId, message, {
              parse_mode: 'Markdown',
              disable_web_page_preview: false
            });

            // Show action buttons
            const keyboard = {
              inline_keyboard: [
                [
                  { text: '💰 Buy', callback_data: `buy:${analysis.token.contractAddress}` },
                  { text: '📊 Details', callback_data: `details:${analysis.token.contractAddress}` },
                ],
              ],
            };

            await this.bot.sendMessage(
              chatId,
              'What would you like to do?',
              { reply_markup: keyboard }
            );

            // Send still hunting status
            await this.bot.sendMessage(
              chatId,
              '🔍 *Still Hunting...*\n\nScanner is active and monitoring for more opportunities 👀',
              { parse_mode: 'Markdown' }
            );

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

      // Send animated hunting start
      const huntingMsg = await this.bot.sendMessage(
        chatId,
        '🔍 *Hunting...*\n\n⏳ Initializing scanner...',
        { parse_mode: 'Markdown' }
      );

      // Animate the hunting process
      await this.sleep(1000);
      await this.bot.editMessageText(
        '🔍 *Hunting...*\n\n🌐 Connecting to blockchain...',
        { chat_id: chatId, message_id: huntingMsg.message_id, parse_mode: 'Markdown' }
      );

      await this.sleep(1000);
      await this.bot.editMessageText(
        '🔍 *Hunting...*\n\n📡 Scanning liquidity pools...',
        { chat_id: chatId, message_id: huntingMsg.message_id, parse_mode: 'Markdown' }
      );

      await this.sleep(1000);
      await this.bot.editMessageText(
        '🔍 *Hunting...*\n\n🎯 Analyzing patterns...',
        { chat_id: chatId, message_id: huntingMsg.message_id, parse_mode: 'Markdown' }
      );

      // Start scanner if not already running
      if (!tokenScanner.isActive()) {
        tokenScanner.start();
      }

      await this.sleep(1000);
      await this.bot.editMessageText(
        '✅ *Hunt Mode Active!*\n\n🎯 Scanner is now live and monitoring the blockchain\n\nYou\'ll receive:\n• 🔔 Real-time token alerts\n• 📊 Detailed analysis\n• 🚨 High-confidence opportunities\n\nUse /stop to deactivate',
        { chat_id: chatId, message_id: huntingMsg.message_id, parse_mode: 'Markdown' }
      );

      // Send initial scanning status
      const stats = tokenScanner.getStats();
      await this.bot.sendMessage(
        chatId,
        `📊 *Scanner Status*\n\nTokens scanned: ${stats.tokensScanned}\nAlerts triggered: ${stats.alertsTriggered}\nStatus: 🟢 Active\n\n👀 Watching the blockchain...`,
        { parse_mode: 'Markdown' }
      );

      logger.info(`User ${msg.from?.id} activated hunt mode`);
    } catch (error) {
      logger.error('Error in handleHunt:', error);
      await this.bot.sendMessage(msg.chat.id, '❌ An error occurred. Please try again.');
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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

      // Get the private key
      const keypair = walletManager.getKeypair(userId);
      if (!keypair) {
        throw new Error('Failed to retrieve wallet keypair');
      }

      const privateKeyArray = Array.from(keypair.secretKey);
      const privateKeyString = JSON.stringify(privateKeyArray);

      const message = `
✅ *Wallet Created Successfully!*

*Public Address:*
\`${result.publicKey}\`

🔑 *Private Key:*
\`${privateKeyString}\`

⚠️ *IMPORTANT SECURITY NOTICE:*
• Save your private key in a secure location
• Never share your private key with anyone
• You need this to recover your wallet
• Delete this message after saving

*Next Steps:*
1. Save your private key securely
2. Set up a 4-digit PIN for protection (recommended)
3. Fund your wallet with SOL
4. Start trading!
      `;

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });

      // Add buttons for PIN setup and export
      const keyboard = {
        inline_keyboard: [
          [{ text: '🔐 Set up PIN Protection', callback_data: 'setup_pin' }],
          [{ text: '📥 Export Private Key', callback_data: 'export_private_key' }],
        ],
      };

      await this.bot.sendMessage(
        chatId,
        'Would you like to set up additional security?',
        { reply_markup: keyboard }
      );

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

  private async handleSetupPinCallback(chatId: number, userId: number): Promise<void> {
    try {
      if (!walletManager.hasWallet(userId)) {
        await this.bot.sendMessage(chatId, '❌ You need a wallet first. Use /createwallet');
        return;
      }

      await this.bot.sendMessage(
        chatId,
        '🔐 *Set up PIN Protection*\n\nPlease enter a 4-digit PIN to protect your private key:\n\n⚠️ Remember this PIN - you\'ll need it to export your private key later.',
        { parse_mode: 'Markdown' }
      );

      this.pendingPinSetup.set(userId, { privateKey: '', action: 'setup' });
    } catch (error) {
      logger.error('Error in handleSetupPinCallback:', error);
      await this.bot.sendMessage(chatId, '❌ An error occurred.');
    }
  }

  private async handleExportPrivateKeyCallback(chatId: number, userId: number): Promise<void> {
    try {
      if (!walletManager.hasWallet(userId)) {
        await this.bot.sendMessage(chatId, '❌ You need a wallet first. Use /createwallet');
        return;
      }

      // Check if PIN is set
      const pinHash = db.getPinHash(userId);
      if (pinHash) {
        await this.bot.sendMessage(
          chatId,
          '🔐 *Enter Your PIN*\n\nPlease enter your 4-digit PIN to export your private key:',
          { parse_mode: 'Markdown' }
        );
        this.pendingPinSetup.set(userId, { privateKey: '', action: 'export' });
      } else {
        // No PIN set, export directly
        await this.exportPrivateKey(chatId, userId);
      }
    } catch (error) {
      logger.error('Error in handleExportPrivateKeyCallback:', error);
      await this.bot.sendMessage(chatId, '❌ An error occurred.');
    }
  }

  private async handlePinSetup(chatId: number, userId: number, pin: string): Promise<void> {
    try {
      const pending = this.pendingPinSetup.get(userId);
      if (!pending) return;

      if (pending.action === 'setup') {
        // Save PIN hash
        const crypto = require('crypto');
        const pinHash = crypto.createHash('sha256').update(pin).digest('hex');
        db.setPinHash(userId, pinHash);

        await this.bot.sendMessage(
          chatId,
          '✅ *PIN Set Successfully!*\n\nYour private key is now protected. Use the Export button to access it with your PIN.',
          { parse_mode: 'Markdown' }
        );

        this.pendingPinSetup.delete(userId);
      } else if (pending.action === 'export') {
        // Verify PIN
        const crypto = require('crypto');
        const pinHash = crypto.createHash('sha256').update(pin).digest('hex');
        const storedHash = db.getPinHash(userId);

        if (pinHash === storedHash) {
          await this.exportPrivateKey(chatId, userId);
          this.pendingPinSetup.delete(userId);
        } else {
          await this.bot.sendMessage(chatId, '❌ Incorrect PIN. Please try again.');
        }
      }
    } catch (error) {
      logger.error('Error in handlePinSetup:', error);
      await this.bot.sendMessage(chatId, '❌ An error occurred.');
      this.pendingPinSetup.delete(userId);
    }
  }

  private async exportPrivateKey(chatId: number, userId: number): Promise<void> {
    try {
      const keypair = walletManager.getKeypair(userId);
      if (!keypair) {
        await this.bot.sendMessage(chatId, '❌ Failed to retrieve private key.');
        return;
      }

      const privateKeyArray = Array.from(keypair.secretKey);
      const privateKeyString = JSON.stringify(privateKeyArray);
      const address = walletManager.getWalletAddress(userId);

      const message = `
🔑 *Your Private Key*

*Wallet Address:*
\`${address}\`

*Private Key:*
\`${privateKeyString}\`

⚠️ *SECURITY WARNING:*
• Keep this private key secure
• Never share it with anyone
• Anyone with this key can access your funds
• Delete this message after saving it
      `;

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      logger.info(`User ${userId} exported private key`);
    } catch (error) {
      logger.error('Error in exportPrivateKey:', error);
      await this.bot.sendMessage(chatId, '❌ Failed to export private key.');
    }
  }

  private formatAnalysis(analysis: AnalysisResult): string {
    const { token, overallScore, confidence, recommendation, technical, fundamental } = analysis;

    const recEmoji = {
      strong_buy: '🚀',
      buy: '✅',
      hold: '⏸️',
      avoid: '❌',
    };

    // Calculate rug probability
    const rugProb = this.calculateRugProbability(analysis);
    const potential = this.predictPotential(analysis);

    let message = `${recEmoji[recommendation]} *${recommendation.toUpperCase().replace('_', ' ')}*\n\n`;
    message += `*${token.symbol}* Analysis\n\n`;

    // Price & Market Info
    message += `💰 *Price:* $${token.price.toFixed(8)}\n`;
    message += `📊 *Market Cap:* $${this.formatNumber(token.marketCap)}\n`;
    message += `💧 *Liquidity:* $${this.formatNumber(token.liquidity)}\n`;
    message += `📈 *24h Volume:* $${this.formatNumber(token.volume24h)}\n`;
    message += `📉 *24h Change:* ${token.priceChange24h > 0 ? '📈' : '📉'} ${token.priceChange24h.toFixed(2)}%\n\n`;

    // Pressure & Signals
    message += `⚖️ *Buy/Sell Pressure:* ${this.getBuySellPressure(technical)}\n`;
    message += `🎯 *Holder Concentration:* ${(fundamental.holderConcentration * 100).toFixed(1)}%\n`;
    message += `👥 *Holders:* ${token.holders.toLocaleString()}\n\n`;

    // Risk Analysis
    message += `⚠️ *Rug Probability:* ${rugProb.emoji} ${rugProb.level} (${rugProb.percentage}%)\n`;
    message += `🔐 *Liquidity Lock:* ${fundamental.liquidityLocked ? '✅ Locked' : '❌ Not Locked'}\n`;
    message += `💼 *Dev Wallet:* ${fundamental.devWalletLocked ? '✅ Locked' : '⚠️ Unlocked'}\n\n`;

    // Smart Money Analysis
    if (analysis.walletSignals && analysis.walletSignals.length > 0) {
      const smartMoney = analysis.walletSignals.filter(w => w.isSmartMoney || w.isWhale);
      if (smartMoney.length > 0) {
        message += `🧠 *Smart Money Activity:* ${smartMoney.length} detected\n`;
        message += `${smartMoney.slice(0, 3).map(w => `  • ${w.isWhale ? '🐋' : '💎'} ${w.profitRate > 0 ? `+${w.profitRate.toFixed(0)}%` : 'New'}`).join('\n')}\n\n`;
      }
    }

    // Prediction
    message += `🔮 *Prediction:* ${potential.emoji} ${potential.text}\n`;
    message += `📊 *Score:* ${overallScore.toFixed(0)}/100 (${(confidence * 100).toFixed(0)}% confident)\n\n`;

    // Links
    message += `🔗 *Links:*\n`;
    message += `  • [DexScreener](https://dexscreener.com/solana/${token.contractAddress})\n`;
    message += `  • [Birdeye](https://birdeye.so/token/${token.contractAddress})\n`;
    message += `  • [Contract](https://solscan.io/token/${token.contractAddress})\n\n`;

    // Reasoning
    message += `💭 *Analysis:*\n${analysis.reasoning}`;

    return message;
  }

  private formatNumber(num: number): string {
    if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(2)}K`;
    return num.toFixed(2);
  }

  private getBuySellPressure(technical: any): string {
    const ratio = technical.volumeBreakout ? 1.5 : 0.8;
    if (ratio > 1.3) return '🟢 Strong Buy Pressure';
    if (ratio > 1.0) return '🟡 Balanced';
    return '🔴 Sell Pressure Dominates';
  }

  private calculateRugProbability(analysis: AnalysisResult): { level: string; percentage: number; emoji: string } {
    let score = 0;

    // Check liquidity lock
    if (!analysis.fundamental.liquidityLocked) score += 30;

    // Check dev wallet
    if (!analysis.fundamental.devWalletLocked) score += 20;

    // Check holder concentration
    if (analysis.fundamental.holderConcentration > 0.5) score += 25;

    // Check top holder percentage
    if (analysis.fundamental.topHolderPercentage > 0.3) score += 15;

    // Check token age
    if (analysis.fundamental.tokenAge < 1) score += 10;

    if (score < 20) return { level: 'Very Low', percentage: score, emoji: '🟢' };
    if (score < 40) return { level: 'Low', percentage: score, emoji: '🟡' };
    if (score < 60) return { level: 'Medium', percentage: score, emoji: '🟠' };
    if (score < 80) return { level: 'High', percentage: score, emoji: '🔴' };
    return { level: 'Very High', percentage: score, emoji: '🚨' };
  }

  private predictPotential(analysis: AnalysisResult): { text: string; emoji: string } {
    const score = analysis.overallScore;
    const confidence = analysis.confidence;
    const technical = analysis.technical;
    const fundamental = analysis.fundamental;

    // Calculate potential multiplier
    let multiplier = 1;

    if (score > 80 && confidence > 0.8) multiplier = 10;
    else if (score > 70 && confidence > 0.7) multiplier = 5;
    else if (score > 60) multiplier = 3;
    else if (score > 50) multiplier = 2;

    // Check for warning signs
    const rugProb = this.calculateRugProbability(analysis);
    if (rugProb.percentage > 60) {
      return { text: '⚠️ HIGH RUG RISK - Not recommended', emoji: '🚨' };
    }

    // Check for pump potential
    if (technical.volumeBreakout && technical.priceAction === 'bullish' && fundamental.holderConcentration < 0.4) {
      return { text: `Potential ${multiplier}x-${multiplier * 2}x pump incoming! 🚀`, emoji: '🚀' };
    }

    // Check for steady growth
    if (score > 60 && fundamental.liquidityLocked && !technical.volumeBreakout) {
      return { text: `Steady ${multiplier}x growth expected 📈`, emoji: '📈' };
    }

    // Quick spike potential
    if (technical.volumeBreakout && score > 50) {
      return { text: `Quick ${multiplier}x spike possible, watch closely! ⚡`, emoji: '⚡' };
    }

    // Conservative
    if (score > 40) {
      return { text: 'Moderate potential, proceed with caution', emoji: '⚖️' };
    }

    return { text: 'Low potential, better opportunities exist', emoji: '😐' };
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
