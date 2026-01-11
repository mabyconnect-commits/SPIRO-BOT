import TelegramBot from 'node-telegram-bot-api';
import { config, TRADING_PRESETS } from '../config';
import tokenAnalyzer from '../analyzer/tokenAnalyzer';
import tradingEngine from '../trading/tradingEngine';
import tokenScanner from '../scanner/tokenScanner';
import patternLearner from '../learning/patternLearner';
import db from '../database';
import logger from '../utils/logger';
import { AnalysisResult } from '../types';

export class AlphaHunterBot {
  private bot: TelegramBot;

  constructor() {
    this.bot = new TelegramBot(config.telegram.botToken, { polling: true });
    this.setupCommands();
    this.setupMessageHandlers();
    this.setupAlerts();
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

    logger.info('Telegram bot commands registered');
  }

  private setupMessageHandlers(): void {
    // Handle contract addresses pasted directly
    this.bot.on('message', async (msg) => {
      if (msg.text && !msg.text.startsWith('/')) {
        const text = msg.text.trim();

        // Check if it looks like a Solana contract address (32-44 characters, alphanumeric)
        if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) {
          await this.analyzeAndRespond(msg.chat.id, text);
        }
      }
    });
  }

  private setupAlerts(): void {
    tokenScanner.onAlert(async (analysis: AnalysisResult) => {
      // Send alert to all users with notifications enabled
      // For now, we'll use a simple approach (in production, iterate through users)
      const message = this.formatAlert(analysis);

      // This would send to all subscribed users
      // For demo, we skip actual sending but log it
      logger.info('Alert generated:', message);
    });
  }

  private async handleStart(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id || 0;

    // Create user if not exists
    db.createUser(userId);

    const welcome = `
🎯 **Welcome to Alpha Hunter!**

I'm your AI-powered Solana runner detection system. Here's what I can do:

🔍 **Scan & Analyze**
• Paste any contract address → Instant deep analysis
• /hunt → Start hunting for runners
• /scan <CA> → Analyze specific token

💰 **Trading**
• /buy <CA> → Buy a token (paper or real)
• /sell <position_id> → Close a position
• /portfolio → View your positions

⚙️ **Settings**
• /preset <name> → Change trading preset
• /autotrade on/off → Toggle auto-trading
• /papermode on/off → Toggle paper trading
• /settings → View your settings

📊 **Learning**
• /patterns → View pattern performance
• /learning → AI learning report

Type /help for more info or paste a contract address to start!
    `;

    await this.bot.sendMessage(chatId, welcome, { parse_mode: 'Markdown' });
  }

  private async handleHelp(msg: TelegramBot.Message): Promise<void> {
    const help = `
📚 **Alpha Hunter Commands**

**Analysis:**
• Paste CA → Instant analysis
• /scan <CA> → Deep token analysis
• /hunt → Start auto-hunting
• /stop → Stop hunting

**Trading:**
• /buy <CA> [amount] → Buy token
• /sell <position> → Sell position
• /portfolio → View positions

**Presets:**
• /preset → Show current preset
• /preset conservative → Low risk
• /preset moderate → Medium risk
• /preset balanced → Default
• /preset aggressive → High risk
• /preset degen → YOLO mode

**Settings:**
• /autotrade on/off → Auto-trade signals
• /papermode on/off → Paper vs real
• /settings → View all settings

**Learning:**
• /patterns → Pattern performance
• /learning → AI learning stats

Ready to hunt some runners! 🚀
    `;

    await this.bot.sendMessage(msg.chat.id, help, { parse_mode: 'Markdown' });
  }

  private async handleHunt(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    tokenScanner.start();

    await this.bot.sendMessage(
      chatId,
      '🔍 **Hunt mode activated!**\n\nScanning for runners... I\'ll alert you when I find something juicy! 🎯',
      { parse_mode: 'Markdown' }
    );
  }

  private async handleStop(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    tokenScanner.stop();

    await this.bot.sendMessage(
      chatId,
      '🛑 Hunt mode stopped.',
      { parse_mode: 'Markdown' }
    );
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

  start(): void {
    logger.info('🤖 Telegram bot started');
    this.bot.sendMessage(config.telegram.botToken, '🚀 Alpha Hunter is online!');
  }
}

export default AlphaHunterBot;
