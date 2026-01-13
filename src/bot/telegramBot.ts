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

interface PendingAction {
  action: string;
  contractAddress?: string;
  symbol?: string;
  name?: string;
  data?: any;
}

export class AlphaHunterBot {
  private bot: TelegramBot;
  private activeHunters: Map<number, boolean> = new Map(); // Track users who have hunt mode active
  private pendingPinSetup: Map<number, { privateKey: string; action: string }> = new Map(); // Track pending PIN setups
  private pendingActions: Map<number, PendingAction> = new Map(); // Track pending user actions (TP, SL, DCA setup)

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

    // Favorites and DCA commands
    this.bot.onText(/\/favorites/, this.handleFavorites.bind(this));
    this.bot.onText(/\/dcaorders/, this.handleDCAOrders.bind(this));
    this.bot.onText(/\/tpslorders/, this.handleTPSLOrders.bind(this));
    this.bot.onText(/\/papertrades/, this.handlePaperTrades.bind(this));

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

          // Check if user has pending actions (TP, SL, DCA setup)
          if (this.pendingActions.has(userId)) {
            await this.handlePendingAction(msg.chat.id, userId, text);
            return;
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
        } else if (data.startsWith('sell:')) {
          const contractAddress = data.substring(5);
          await this.handleSellCallback(chatId, contractAddress, query.from.id);
        } else if (data.startsWith('settp:')) {
          const contractAddress = data.substring(6);
          await this.handleSetTPCallback(chatId, contractAddress, query.from.id);
        } else if (data.startsWith('setsl:')) {
          const contractAddress = data.substring(6);
          await this.handleSetSLCallback(chatId, contractAddress, query.from.id);
        } else if (data.startsWith('setdca:')) {
          const parts = data.substring(7).split(':');
          const contractAddress = parts[0];
          const symbol = parts[1] || '';
          await this.handleSetDCACallback(chatId, contractAddress, symbol, query.from.id);
        } else if (data.startsWith('favorite:')) {
          const parts = data.substring(9).split(':');
          const contractAddress = parts[0];
          const symbol = parts[1] || '';
          const name = parts[2] || '';
          await this.handleFavoriteCallback(chatId, contractAddress, symbol, name, query.from.id);
        } else if (data.startsWith('unfavorite:')) {
          const contractAddress = data.substring(11);
          await this.handleUnfavoriteCallback(chatId, contractAddress, query.from.id);
        } else if (data.startsWith('details:')) {
          const contractAddress = data.substring(8);
          await this.handleDetailsCallback(chatId, contractAddress);
        } else if (data.startsWith('copy:')) {
          const contractAddress = data.substring(5);
          await this.bot.sendMessage(chatId, `📋 Contract Address copied:\n\`${contractAddress}\``, {
            parse_mode: 'Markdown'
          });
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
    // Setup scan notifications to show tokens being scanned
    tokenScanner.onScanNotify(async (tokenInfo: { address: string; name?: string; symbol?: string }) => {
      for (const [chatId, isActive] of this.activeHunters.entries()) {
        if (isActive) {
          try {
            // Get token info from DexScreener if not provided
            let displayName = tokenInfo.symbol || 'Token';
            let displayCA = tokenInfo.address;

            // Format CA for display (first 8 and last 6 characters)
            const shortCA = `${displayCA.substring(0, 8)}...${displayCA.substring(displayCA.length - 6)}`;

            const scanMessage = `
🔍 *Scanning Token*

📝 **${displayName}**
📋 CA: \`${displayCA}\`

⏳ Analyzing...
            `;

            await this.bot.sendMessage(chatId, scanMessage, {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '📋 Copy CA', callback_data: `copy:${displayCA}` },
                  ],
                ]
              }
            });
          } catch (error) {
            logger.error(`Failed to send scan notification to chat ${chatId}:`, error);
          }
        }
      }
    });

    // Setup buy signal notifications
    tokenScanner.onBuySignal(async (analysis: AnalysisResult) => {
      for (const [chatId, isActive] of this.activeHunters.entries()) {
        if (isActive) {
          try {
            const buySignalMessage = `
🚨 *BUY SIGNAL DETECTED!* 🚨

💎 **${analysis.token.symbol}** - ${analysis.token.name}

📊 Score: ${analysis.overallScore.toFixed(0)}/100
🎯 Confidence: ${(analysis.confidence * 100).toFixed(0)}%
💰 Price: $${analysis.token.price.toFixed(8)}

${this.getPotentialText(analysis)}

✅ Paper trade executed automatically!
📈 Monitoring for profit opportunities...
            `;

            const isFav = db.isFavorite(chatId, analysis.token.contractAddress);

            // Shorten symbol and name to avoid exceeding 64-byte callback limit
            const shortSymbol = analysis.token.symbol.substring(0, 10);
            const shortName = analysis.token.name.substring(0, 15);

            const keyboard = {
              inline_keyboard: [
                [
                  { text: '💰 Buy Now', callback_data: `buy:${analysis.token.contractAddress}` },
                  { text: '💸 Sell', callback_data: `sell:${analysis.token.contractAddress}` },
                ],
                [
                  { text: '🎯 Set TP', callback_data: `settp:${analysis.token.contractAddress}` },
                  { text: '🛡️ Set SL', callback_data: `setsl:${analysis.token.contractAddress}` },
                ],
                [
                  { text: '📊 Set DCA', callback_data: `setdca:${analysis.token.contractAddress}:${shortSymbol}` },
                  { text: isFav ? '⭐ Unfavorite' : '⭐ Favorite', callback_data: isFav ? `unfavorite:${analysis.token.contractAddress}` : `favorite:${analysis.token.contractAddress}:${shortSymbol}:${shortName}` },
                ],
                [
                  { text: '📊 Full Details', callback_data: `details:${analysis.token.contractAddress}` },
                  { text: '📋 Copy CA', callback_data: `copy:${analysis.token.contractAddress}` },
                ],
              ],
            };

            await this.bot.sendMessage(chatId, buySignalMessage, {
              parse_mode: 'Markdown',
              reply_markup: keyboard
            });
          } catch (error) {
            logger.error(`Failed to send buy signal to chat ${chatId}:`, error);
          }
        }
      }
    });

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
            const isFav = db.isFavorite(chatId, analysis.token.contractAddress);

            // Shorten symbol and name to avoid exceeding 64-byte callback limit
            const shortSymbol = analysis.token.symbol.substring(0, 10);
            const shortName = analysis.token.name.substring(0, 15);

            const keyboard = {
              inline_keyboard: [
                [
                  { text: '💰 Buy', callback_data: `buy:${analysis.token.contractAddress}` },
                  { text: '💸 Sell', callback_data: `sell:${analysis.token.contractAddress}` },
                ],
                [
                  { text: '🎯 Set TP', callback_data: `settp:${analysis.token.contractAddress}` },
                  { text: '🛡️ Set SL', callback_data: `setsl:${analysis.token.contractAddress}` },
                ],
                [
                  { text: '📊 Set DCA', callback_data: `setdca:${analysis.token.contractAddress}:${shortSymbol}` },
                  { text: isFav ? '⭐ Unfavorite' : '⭐ Favorite', callback_data: isFav ? `unfavorite:${analysis.token.contractAddress}` : `favorite:${analysis.token.contractAddress}:${shortSymbol}:${shortName}` },
                ],
                [
                  { text: '📊 Details', callback_data: `details:${analysis.token.contractAddress}` },
                  { text: '📋 Copy CA', callback_data: `copy:${analysis.token.contractAddress}` },
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

      // Start automated paper trading
      tokenScanner.startAutomatedPaperTrading();

      await this.sleep(1000);
      await this.bot.editMessageText(
        '✅ *Hunt Mode Active!*\n\n🎯 Scanner is now live and monitoring the blockchain\n🤖 Automated paper trading enabled (every 2 min)\n\nYou\'ll receive:\n• 🔔 Real-time token alerts\n• 📊 Detailed analysis\n• 🚨 Buy signals for good tokens\n• 📈 Paper trade updates\n\nUse /stop to deactivate',
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
        tokenScanner.stopAutomatedPaperTrading();
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
    try {
      await this.bot.sendMessage(chatId, '🔍 Analyzing token... This may take a moment.');

      const analysis = await tokenAnalyzer.analyzeToken(contractAddress);

      if (!analysis) {
        await this.bot.sendMessage(chatId, '❌ Failed to analyze token. Make sure the contract address is valid.');
        return;
      }

      const message = this.formatAnalysis(analysis);
      await this.bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });

      // Show action buttons
      const userId = chatId; // For now, assume chatId = userId
      const isFav = db.isFavorite(userId, contractAddress);

      // Shorten symbol and name to avoid exceeding 64-byte callback limit
      const shortSymbol = analysis.token.symbol.substring(0, 10);
      const shortName = analysis.token.name.substring(0, 15);

      // Build keyboard with action buttons
      const keyboard = {
        inline_keyboard: [
          [
            { text: '💰 Buy', callback_data: `buy:${contractAddress}` },
            { text: '💸 Sell', callback_data: `sell:${contractAddress}` },
          ],
          [
            { text: '🎯 Set TP', callback_data: `settp:${contractAddress}` },
            { text: '🛡️ Set SL', callback_data: `setsl:${contractAddress}` },
          ],
          [
            { text: '📊 Set DCA', callback_data: `setdca:${contractAddress}:${shortSymbol}` },
            { text: isFav ? '⭐ Unfavorite' : '⭐ Favorite', callback_data: isFav ? `unfavorite:${contractAddress}` : `favorite:${contractAddress}:${shortSymbol}:${shortName}` },
          ],
          [
            { text: '📊 Details', callback_data: `details:${contractAddress}` },
            { text: '📋 Copy CA', callback_data: `copy:${contractAddress}` },
          ],
        ],
      };

      await this.bot.sendMessage(
        chatId,
        'What would you like to do?',
        { reply_markup: keyboard }
      );

      logger.info(`Successfully sent analysis and buttons for ${analysis.token.symbol}`);
    } catch (error) {
      logger.error('Error in analyzeAndRespond:', error);
      throw error; // Re-throw to be caught by the outer handler
    }
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

  private async handleSellCallback(chatId: number, contractAddress: string, userId: number): Promise<void> {
    try {
      // Find open positions for this token
      const positions = db.getOpenPositions(userId);
      const position = positions.find(p => p.contractAddress === contractAddress);

      if (!position) {
        await this.bot.sendMessage(chatId, '❌ You don\'t have an open position for this token.');
        return;
      }

      await this.bot.sendMessage(chatId, '🔄 Updating position and executing sell...');

      // Update position with current price
      await tradingEngine.updatePosition(position);

      // Sell the position
      const success = await tradingEngine.sell(position, position.type === 'paper');

      if (success) {
        const pnlEmoji = position.pnl > 0 ? '🟢' : '🔴';
        await this.bot.sendMessage(
          chatId,
          `✅ *Position Closed!*\n\n` +
          `${position.symbol}\n` +
          `${pnlEmoji} PnL: ${position.pnl.toFixed(4)} SOL (${position.pnlPercentage.toFixed(2)}%)`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await this.bot.sendMessage(chatId, '❌ Failed to close position.');
      }
    } catch (error) {
      logger.error('Error in handleSellCallback:', error);
      await this.bot.sendMessage(chatId, '❌ An error occurred while selling.');
    }
  }

  private async handleSetTPCallback(chatId: number, contractAddress: string, userId: number): Promise<void> {
    try {
      // Check if user has an open position for this token
      const positions = db.getOpenPositions(userId);
      const position = positions.find(p => p.contractAddress === contractAddress);

      if (!position) {
        await this.bot.sendMessage(
          chatId,
          '⚠️ You don\'t have an open position for this token yet.\n\nBuy the token first, then set Take Profit.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      await this.bot.sendMessage(
        chatId,
        '🎯 *Set Take Profit*\n\nEnter the percentage gain you want to take profit at (e.g., "50" for +50%):\n\nExample: If you enter 50, your position will automatically close when it reaches +50% profit.',
        { parse_mode: 'Markdown' }
      );

      this.pendingActions.set(userId, {
        action: 'set_tp',
        contractAddress,
        data: { positionId: position.id, entryPrice: position.entryPrice }
      });
    } catch (error) {
      logger.error('Error in handleSetTPCallback:', error);
      await this.bot.sendMessage(chatId, '❌ An error occurred.');
    }
  }

  private async handleSetSLCallback(chatId: number, contractAddress: string, userId: number): Promise<void> {
    try {
      // Check if user has an open position for this token
      const positions = db.getOpenPositions(userId);
      const position = positions.find(p => p.contractAddress === contractAddress);

      if (!position) {
        await this.bot.sendMessage(
          chatId,
          '⚠️ You don\'t have an open position for this token yet.\n\nBuy the token first, then set Stop Loss.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      await this.bot.sendMessage(
        chatId,
        '🛡️ *Set Stop Loss*\n\nEnter the percentage loss you want to stop at (e.g., "10" for -10%):\n\nExample: If you enter 10, your position will automatically close if it drops to -10% loss.',
        { parse_mode: 'Markdown' }
      );

      this.pendingActions.set(userId, {
        action: 'set_sl',
        contractAddress,
        data: { positionId: position.id, entryPrice: position.entryPrice }
      });
    } catch (error) {
      logger.error('Error in handleSetSLCallback:', error);
      await this.bot.sendMessage(chatId, '❌ An error occurred.');
    }
  }

  private async handleSetDCACallback(chatId: number, contractAddress: string, symbol: string, userId: number): Promise<void> {
    try {
      await this.bot.sendMessage(
        chatId,
        '📊 *Set Up Dollar Cost Averaging*\n\n' +
        'DCA will automatically buy this token at regular intervals.\n\n' +
        'Send your DCA settings in this format:\n' +
        '`amount frequency executions`\n\n' +
        'Example: `0.1 60 10`\n' +
        '• Amount: 0.1 SOL per buy\n' +
        '• Frequency: Every 60 minutes\n' +
        '• Executions: 10 total buys\n\n' +
        'This will invest 1 SOL total (0.1 × 10) over ~10 hours.',
        { parse_mode: 'Markdown' }
      );

      this.pendingActions.set(userId, {
        action: 'set_dca',
        contractAddress,
        symbol
      });
    } catch (error) {
      logger.error('Error in handleSetDCACallback:', error);
      await this.bot.sendMessage(chatId, '❌ An error occurred.');
    }
  }

  private async handleFavoriteCallback(chatId: number, contractAddress: string, symbol: string, name: string, userId: number): Promise<void> {
    try {
      db.addFavorite(userId, contractAddress, symbol, name);
      await this.bot.sendMessage(
        chatId,
        `⭐ *Added to Favorites!*\n\n${symbol} has been added to your favorites list.\n\nUse /favorites to view all your favorite tokens.`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      logger.error('Error in handleFavoriteCallback:', error);
      await this.bot.sendMessage(chatId, '❌ An error occurred.');
    }
  }

  private async handleUnfavoriteCallback(chatId: number, contractAddress: string, userId: number): Promise<void> {
    try {
      db.removeFavorite(userId, contractAddress);
      await this.bot.sendMessage(
        chatId,
        '✅ Removed from favorites.',
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      logger.error('Error in handleUnfavoriteCallback:', error);
      await this.bot.sendMessage(chatId, '❌ An error occurred.');
    }
  }

  private async handlePendingAction(chatId: number, userId: number, text: string): Promise<void> {
    try {
      const pending = this.pendingActions.get(userId);
      if (!pending) return;

      if (pending.action === 'set_tp') {
        const percentage = parseFloat(text);
        if (isNaN(percentage) || percentage <= 0) {
          await this.bot.sendMessage(chatId, '❌ Invalid percentage. Please enter a positive number (e.g., 50 for +50%).');
          return;
        }

        const { positionId, entryPrice } = pending.data;
        const triggerPrice = entryPrice * (1 + percentage / 100);

        db.createTPSLOrder(
          userId,
          positionId,
          pending.contractAddress!,
          'tp',
          triggerPrice,
          percentage
        );

        await this.bot.sendMessage(
          chatId,
          `✅ *Take Profit Set!*\n\n` +
          `Trigger: +${percentage}%\n` +
          `Price: $${triggerPrice.toFixed(8)}\n\n` +
          `Your position will automatically close when it reaches this profit level.`,
          { parse_mode: 'Markdown' }
        );

        this.pendingActions.delete(userId);
      } else if (pending.action === 'set_sl') {
        const percentage = parseFloat(text);
        if (isNaN(percentage) || percentage <= 0) {
          await this.bot.sendMessage(chatId, '❌ Invalid percentage. Please enter a positive number (e.g., 10 for -10%).');
          return;
        }

        const { positionId, entryPrice } = pending.data;
        const triggerPrice = entryPrice * (1 - percentage / 100);

        db.createTPSLOrder(
          userId,
          positionId,
          pending.contractAddress!,
          'sl',
          triggerPrice,
          -percentage
        );

        await this.bot.sendMessage(
          chatId,
          `✅ *Stop Loss Set!*\n\n` +
          `Trigger: -${percentage}%\n` +
          `Price: $${triggerPrice.toFixed(8)}\n\n` +
          `Your position will automatically close if it drops to this loss level.`,
          { parse_mode: 'Markdown' }
        );

        this.pendingActions.delete(userId);
      } else if (pending.action === 'set_dca') {
        const parts = text.trim().split(/\s+/);
        if (parts.length !== 3) {
          await this.bot.sendMessage(
            chatId,
            '❌ Invalid format. Please use: `amount frequency executions`\n\nExample: `0.1 60 10`',
            { parse_mode: 'Markdown' }
          );
          return;
        }

        const solAmount = parseFloat(parts[0]);
        const frequencyMinutes = parseInt(parts[1]);
        const totalExecutions = parseInt(parts[2]);

        if (isNaN(solAmount) || isNaN(frequencyMinutes) || isNaN(totalExecutions)) {
          await this.bot.sendMessage(chatId, '❌ Invalid numbers. Please check your input.');
          return;
        }

        if (solAmount <= 0 || frequencyMinutes <= 0 || totalExecutions <= 0) {
          await this.bot.sendMessage(chatId, '❌ All values must be positive.');
          return;
        }

        const orderId = db.createDCAOrder(
          userId,
          pending.contractAddress!,
          pending.symbol!,
          solAmount,
          frequencyMinutes,
          totalExecutions
        );

        const totalInvestment = solAmount * totalExecutions;
        const durationHours = (frequencyMinutes * totalExecutions) / 60;

        await this.bot.sendMessage(
          chatId,
          `✅ *DCA Order Created!*\n\n` +
          `Token: ${pending.symbol}\n` +
          `Amount: ${solAmount} SOL per buy\n` +
          `Frequency: Every ${frequencyMinutes} minutes\n` +
          `Total Buys: ${totalExecutions}\n\n` +
          `📊 Total Investment: ${totalInvestment} SOL\n` +
          `⏱️ Duration: ~${durationHours.toFixed(1)} hours\n\n` +
          `First buy will execute in ${frequencyMinutes} minutes.\n` +
          `Use /dcaorders to manage your DCA orders.`,
          { parse_mode: 'Markdown' }
        );

        this.pendingActions.delete(userId);
      }
    } catch (error) {
      logger.error('Error in handlePendingAction:', error);
      await this.bot.sendMessage(chatId, '❌ An error occurred.');
      this.pendingActions.delete(userId);
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

  private getPotentialText(analysis: AnalysisResult): string {
    const potential = this.predictPotential(analysis);
    return `🔮 ${potential.emoji} ${potential.text}`;
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

  private async handleFavorites(msg: TelegramBot.Message): Promise<void> {
    try {
      const userId = msg.from?.id || 0;
      const chatId = msg.chat.id;

      const favorites = db.getFavorites(userId);

      if (favorites.length === 0) {
        await this.bot.sendMessage(
          chatId,
          '⭐ *Your Favorites*\n\nYou haven\'t added any tokens to favorites yet.\n\nAdd tokens to favorites by clicking the ⭐ button after analyzing them.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      let message = '⭐ *Your Favorite Tokens*\n\n';

      for (const fav of favorites) {
        message += `*${fav.symbol}* - ${fav.name}\n`;
        message += `Contract: \`${fav.contractAddress}\`\n`;
        message += `Added: ${new Date(fav.addedAt).toLocaleDateString()}\n\n`;
      }

      message += `Total: ${favorites.length} favorite${favorites.length !== 1 ? 's' : ''}\n\n`;
      message += 'Paste any contract address to analyze it!';

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('Error in handleFavorites:', error);
      await this.bot.sendMessage(msg.chat.id, '❌ An error occurred.');
    }
  }

  private async handleDCAOrders(msg: TelegramBot.Message): Promise<void> {
    try {
      const userId = msg.from?.id || 0;
      const chatId = msg.chat.id;

      const orders = db.getActiveDCAOrders(userId);

      if (orders.length === 0) {
        await this.bot.sendMessage(
          chatId,
          '📊 *DCA Orders*\n\nYou don\'t have any active DCA orders.\n\nSet up DCA orders by clicking the "Set DCA" button after analyzing a token.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      let message = '📊 *Active DCA Orders*\n\n';

      for (const order of orders) {
        const progress = `${order.executed_count}/${order.total_executions}`;
        const totalInvested = order.sol_amount * order.executed_count;
        const nextExec = new Date(order.next_execution);
        const timeUntil = Math.max(0, Math.floor((nextExec.getTime() - Date.now()) / 60000));

        message += `*${order.symbol}*\n`;
        message += `Amount: ${order.sol_amount} SOL per buy\n`;
        message += `Frequency: Every ${order.frequency_minutes} minutes\n`;
        message += `Progress: ${progress} buys\n`;
        message += `Invested: ${totalInvested.toFixed(2)} SOL\n`;
        message += `Next buy: ${timeUntil < 60 ? `${timeUntil} minutes` : `${(timeUntil / 60).toFixed(1)} hours`}\n`;
        message += `Order ID: ${order.id}\n\n`;
      }

      message += 'To cancel an order, use: /canceldca <order_id>';

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('Error in handleDCAOrders:', error);
      await this.bot.sendMessage(msg.chat.id, '❌ An error occurred.');
    }
  }

  private async handleTPSLOrders(msg: TelegramBot.Message): Promise<void> {
    try {
      const userId = msg.from?.id || 0;
      const chatId = msg.chat.id;

      const orders = db.getActiveTPSLOrders(userId);

      if (orders.length === 0) {
        await this.bot.sendMessage(
          chatId,
          '🎯 *TP/SL Orders*\n\nYou don\'t have any active Take Profit or Stop Loss orders.\n\nSet them up by clicking "Set TP" or "Set SL" after buying a token.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      let message = '🎯 *Active TP/SL Orders*\n\n';

      const tpOrders = orders.filter(o => o.order_type === 'tp');
      const slOrders = orders.filter(o => o.order_type === 'sl');

      if (tpOrders.length > 0) {
        message += '*Take Profit Orders:*\n';
        for (const order of tpOrders) {
          message += `• ${order.trigger_percentage > 0 ? '+' : ''}${order.trigger_percentage.toFixed(1)}% @ $${order.trigger_price.toFixed(8)}\n`;
          message += `  Position ID: ${order.position_id}\n`;
        }
        message += '\n';
      }

      if (slOrders.length > 0) {
        message += '*Stop Loss Orders:*\n';
        for (const order of slOrders) {
          message += `• ${order.trigger_percentage.toFixed(1)}% @ $${order.trigger_price.toFixed(8)}\n`;
          message += `  Position ID: ${order.position_id}\n`;
        }
        message += '\n';
      }

      message += `Total: ${orders.length} order${orders.length !== 1 ? 's' : ''}`;

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('Error in handleTPSLOrders:', error);
      await this.bot.sendMessage(msg.chat.id, '❌ An error occurred.');
    }
  }

  private async handlePaperTrades(msg: TelegramBot.Message): Promise<void> {
    try {
      const userId = msg.from?.id || 0;
      const chatId = msg.chat.id;

      // Get all paper trades
      const paperTrades = db.getAllPaperTrades(userId);

      if (paperTrades.length === 0) {
        await this.bot.sendMessage(
          chatId,
          '📝 *Paper Trades*\n\nNo paper trades yet! Start /hunt mode to begin paper trading launchpad tokens.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Get stats
      const stats = db.getPaperTradeStats(userId);

      let message = '📝 *Paper Trade Portfolio*\n\n';
      message += `📊 *Overall Stats:*\n`;
      message += `Total Trades: ${stats.total_trades}\n`;
      message += `Open: ${stats.open_trades} | Winners: ${stats.winners} | Losers: ${stats.losers}\n`;
      message += `Win Rate: ${stats.total_trades > stats.open_trades ? ((stats.winners / (stats.total_trades - stats.open_trades)) * 100).toFixed(1) : 0}%\n`;
      message += `Avg PnL: ${stats.avg_pnl_percentage ? stats.avg_pnl_percentage.toFixed(2) : 0}%\n`;
      message += `Total PnL: ${stats.total_pnl ? stats.total_pnl.toFixed(4) : 0} SOL\n\n`;

      // Show 2x+ winners first
      const winners2x = paperTrades.filter(t => t.pnl_percentage >= 100);
      if (winners2x.length > 0) {
        message += `🎉 *2x+ Winners (${winners2x.length}):*\n`;
        for (const trade of winners2x.slice(0, 5)) {
          message += `• ${trade.symbol}: +${trade.pnl_percentage.toFixed(2)}%\n`;
          message += `  Entry: $${trade.entry_price.toFixed(8)}\n`;
          message += `  Current: $${trade.current_price.toFixed(8)}\n`;
        }
        message += '\n';
      }

      // Show recent open positions
      const openPositions = paperTrades.filter(t => t.status === 'open').slice(0, 10);
      if (openPositions.length > 0) {
        message += `📊 *Open Positions (${openPositions.length}):*\n`;
        for (const trade of openPositions.slice(0, 5)) {
          const pnlEmoji = trade.pnl_percentage > 0 ? '🟢' : trade.pnl_percentage < 0 ? '🔴' : '⚪';
          message += `${pnlEmoji} ${trade.symbol}: ${trade.pnl_percentage > 0 ? '+' : ''}${trade.pnl_percentage.toFixed(2)}%\n`;
        }
        message += '\n';
      }

      // Show recent closed positions
      const closedPositions = paperTrades.filter(t => t.status === 'closed').slice(0, 5);
      if (closedPositions.length > 0) {
        message += `📖 *Recent Closed (${closedPositions.length}):*\n`;
        for (const trade of closedPositions) {
          const resultEmoji = trade.pnl > 0 ? '✅' : '❌';
          message += `${resultEmoji} ${trade.symbol}: ${trade.pnl > 0 ? '+' : ''}${trade.pnl_percentage.toFixed(2)}%\n`;
        }
      }

      message += '\n💡 *Bot Thesis:*\n';
      message += 'Paper trading ALL launchpad tokens (PumpFun, Meteora, etc.) to learn patterns. ';
      message += 'Tokens with 2x+ gains are analyzed to improve buy signal accuracy. ';
      message += 'The more winners we collect, the better the strategy becomes! 🧠';

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('Error in handlePaperTrades:', error);
      await this.bot.sendMessage(msg.chat.id, '❌ An error occurred.');
    }
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
        { command: 'favorites', description: 'View your favorite tokens' },
        { command: 'dcaorders', description: 'View active DCA orders' },
        { command: 'tpslorders', description: 'View active TP/SL orders' },
        { command: 'papertrades', description: 'View paper trade portfolio with thesis' },
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
