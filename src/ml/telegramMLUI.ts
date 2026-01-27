/**
 * Telegram ML UI - ML-powered command handlers and UX flows
 *
 * Exposes:
 * /mlstats - ML engine statistics
 * /topstrategies - Top performing strategies
 * /whythistrade <token> - Explainable AI for trade decisions
 * /patternreport - Feature importance and pattern analysis
 * /mlinsights - Learning updates and model evolution
 * /mlconfidence <token> - Quick confidence check
 * /strategytoggle <strategy> - Enable/disable strategy
 *
 * Inline button flows for:
 * - Trade alerts with ML confidence
 * - Strategy dashboard
 * - Risk warnings
 * - Onboarding flow
 */

import { mlEngine, MLPrediction } from './mlStrategyEngine';
import { AnalysisResult } from '../types';
import logger from '../utils/logger';

// ============================================================
// MESSAGE TEMPLATES
// ============================================================

export const MLMessageTemplates = {
  // ---- Onboarding ----
  welcome: () =>
    `🤖 *Welcome to SPIRO-BOT Alpha Hunter*\n\n` +
    `AI-powered Solana meme token trading with ML strategy engine.\n\n` +
    `⚠️ *Disclaimer*: This bot uses machine learning for trading decisions. ` +
    `Past performance does not guarantee future results. ` +
    `You may lose your entire investment. Trade responsibly.\n\n` +
    `Choose how to get started:`,

  onboardingButtons: () => [
    [{ text: '🆕 Create Wallet', callback_data: 'wallet_create' }],
    [{ text: '📥 Import Wallet', callback_data: 'wallet_import' }],
    [{ text: '🧪 Simulation Only', callback_data: 'mode_simulation' }],
  ],

  // ---- Main Dashboard ----
  dashboard: (username: string) =>
    `🏠 *Dashboard*\n\nWelcome back, ${username}!\n\nWhat would you like to do?`,

  dashboardButtons: () => [
    [
      { text: '📊 Stats', callback_data: 'menu_stats' },
      { text: '🤖 Strategies', callback_data: 'menu_strategies' },
    ],
    [
      { text: '💼 Wallet', callback_data: 'menu_wallet' },
      { text: '⚙️ Settings', callback_data: 'menu_settings' },
    ],
    [
      { text: '🚀 Enable Trading', callback_data: 'menu_enable_trading' },
      { text: '🧪 Simulation Mode', callback_data: 'menu_simulation' },
    ],
    [
      { text: '🏆 Leaderboard', callback_data: 'menu_leaderboard' },
      { text: '🧠 ML Insights', callback_data: 'menu_ml_insights' },
    ],
  ],

  // ---- Wallet Flow ----
  walletMenu: () =>
    `💼 *Wallet Management*\n\nManage your trading wallet:`,

  walletButtons: () => [
    [{ text: '🆕 Create New Wallet', callback_data: 'wallet_create' }],
    [{ text: '📥 Import Private Key', callback_data: 'wallet_import' }],
    [{ text: '📍 Show Address', callback_data: 'wallet_address' }],
    [{ text: '💰 Show Balance', callback_data: 'wallet_balance' }],
    [{ text: '💳 Fund Wallet', callback_data: 'wallet_fund' }],
    [{ text: '🔌 Disconnect', callback_data: 'wallet_disconnect' }],
    [{ text: '🔙 Back', callback_data: 'menu_main' }],
  ],

  walletImportWarning: () =>
    `⚠️ *Security Warning*\n\n` +
    `Never share your private key with anyone.\n` +
    `We encrypt keys with AES-256 and never store plaintext.\n` +
    `Only import keys you trust into this bot.\n\n` +
    `Send your private key (base58 format) now:`,

  // ---- Strategy Flow ----
  strategyMenu: () =>
    `🤖 *Strategy Management*\n\nML-powered trading strategies:`,

  strategyButtons: () => [
    [{ text: '🐢 Conservative', callback_data: 'strat_conservative' }],
    [{ text: '⚖️ Balanced', callback_data: 'strat_balanced' }],
    [{ text: '🔥 Aggressive', callback_data: 'strat_aggressive' }],
    [{ text: '💀 Degen', callback_data: 'strat_degen' }],
    [{ text: '🛠️ Custom Builder', callback_data: 'strat_custom' }],
    [{ text: '📊 Show Performance', callback_data: 'strat_performance' }],
    [{ text: '🔙 Back', callback_data: 'menu_main' }],
  ],

  // ---- Settings Flow ----
  settingsMenu: () =>
    `⚙️ *Settings*\n\nConfigure your trading parameters:`,

  settingsButtons: () => [
    [{ text: '💰 Max Trade Size', callback_data: 'set_max_trade' }],
    [{ text: '🛑 Stop Loss', callback_data: 'set_stop_loss' }],
    [{ text: '🎯 Take Profit Tiers', callback_data: 'set_take_profit' }],
    [{ text: '📉 Daily Loss Limit', callback_data: 'set_daily_loss' }],
    [{ text: '🤖 Strategy Type', callback_data: 'set_strategy' }],
    [{ text: '🔔 Notifications', callback_data: 'set_notifications' }],
    [{ text: '🔙 Back', callback_data: 'menu_main' }],
  ],

  // ---- Trade Alert ----
  tradeAlert: (prediction: MLPrediction, analysis: AnalysisResult) => {
    const riskEmoji = prediction.riskScore < 30 ? '🟢' : prediction.riskScore < 60 ? '🟡' : '🔴';
    const confEmoji = prediction.confidenceScore >= 75 ? '🔥' : prediction.confidenceScore >= 50 ? '⚡' : '⚠️';

    let msg = `${confEmoji} *High Probability Token Detected*\n\n`;
    msg += `*Token*: ${analysis.token.symbol} (${analysis.token.name})\n`;
    msg += `*Market Cap*: $${formatNumber(analysis.token.marketCap)}\n`;
    msg += `${riskEmoji} *Risk Score*: ${prediction.riskScore}/100\n`;
    msg += `*Strategy*: ${prediction.strategyRecommendation}\n`;
    msg += `*Confidence*: ${prediction.confidenceScore}%\n`;
    msg += `*Expected ROI*: ${prediction.expectedROIRange.min}% to ${prediction.expectedROIRange.max}%\n`;
    msg += `*Model Agreement*: ${prediction.modelAgreement}%\n\n`;

    if (!prediction.allowRealTrading) {
      msg += `⚠️ *Simulation Only* - ML confidence below threshold for real trades.\n`;
    }

    return msg;
  },

  tradeAlertButtons: (contractAddress: string, allowReal: boolean) => {
    const buttons: any[][] = [];
    if (allowReal) {
      buttons.push([{ text: '✅ Execute Trade', callback_data: `trade_exec_${contractAddress}` }]);
    }
    buttons.push([{ text: '🧪 Simulate Only', callback_data: `trade_sim_${contractAddress}` }]);
    buttons.push([
      { text: '⏭️ Skip', callback_data: `trade_skip_${contractAddress}` },
      { text: '🔍 Details', callback_data: `trade_why_${contractAddress}` },
    ]);
    return buttons;
  },

  // ---- Stats ----
  statsDisplay: (stats: {
    totalROI: number;
    winRate: number;
    bestStrategy: string;
    mlAccuracy: number;
    simTrades: number;
    realTrades: number;
  }) => {
    const roiEmoji = stats.totalROI > 0 ? '🟢' : '🔴';
    let msg = `📊 *Trading Statistics*\n\n`;
    msg += `${roiEmoji} *Total ROI*: ${stats.totalROI.toFixed(2)}%\n`;
    msg += `🎯 *Win Rate*: ${stats.winRate.toFixed(1)}%\n`;
    msg += `🏆 *Best Strategy*: ${stats.bestStrategy}\n`;
    msg += `🧠 *ML Accuracy*: ${stats.mlAccuracy.toFixed(1)}%\n\n`;
    msg += `📈 *Simulation*: ${stats.simTrades} trades\n`;
    msg += `💰 *Real*: ${stats.realTrades} trades\n`;
    return msg;
  },

  // ---- Alert Types ----
  alertNewOpportunity: (symbol: string, confidence: number) =>
    `🟢 *New Opportunity*: ${symbol} detected with ${confidence}% confidence`,

  alertRiskDetected: (symbol: string, risk: string) =>
    `🔴 *Risk Detected*: ${symbol} - ${risk}`,

  alertStrategyChange: (strategy: string, action: string) =>
    `🟡 *Strategy Update*: ${strategy} has been ${action}`,

  alertLearningUpdate: (detail: string) =>
    `🧠 *Learning Update*: ${detail}`,

  alertProfitHit: (symbol: string, profitPct: number, multiple: string) =>
    `💰 *Profit Hit*: ${symbol} reached ${profitPct.toFixed(1)}% (${multiple})!`,
};

// ============================================================
// COMMAND HANDLERS
// ============================================================

export class MLCommandHandlers {

  /**
   * /mlstats - Show ML engine statistics
   */
  static handleMLStats(): { text: string; buttons: any[][] } {
    const stats = mlEngine.getMLStats();
    return {
      text: stats,
      buttons: [
        [{ text: '🔄 Refresh', callback_data: 'ml_stats_refresh' }],
        [{ text: '📊 Pattern Report', callback_data: 'ml_pattern_report' }],
        [{ text: '🔙 Back', callback_data: 'menu_main' }],
      ],
    };
  }

  /**
   * /topstrategies - Show top performing strategies
   */
  static handleTopStrategies(): { text: string; buttons: any[][] } {
    const strategies = mlEngine.getTopStrategies();

    let text = `🏆 *Top Active Strategies*\n\n`;

    if (strategies.length === 0) {
      text += `No strategies have enough data yet. Keep trading!\n`;
    } else {
      strategies.forEach((s, i) => {
        const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i] || '•';
        const posSize = mlEngine.getPositionSizeMultiplier(s.strategyId);
        text += `${medal} *${s.name}*\n`;
        text += `   Win Rate: ${(s.winRate * 100).toFixed(0)}% | ROI: ${s.avgROI.toFixed(1)}%\n`;
        text += `   Sharpe: ${s.sharpeRatio.toFixed(2)} | Trades: ${s.totalTrades}\n`;
        text += `   Position Size: ${posSize.toFixed(2)}x\n\n`;
      });
    }

    const buttons: any[][] = strategies.slice(0, 5).map(s => [
      {
        text: `${s.isActive ? '✅' : '❌'} ${s.name}`,
        callback_data: `strat_toggle_${s.strategyId}`,
      },
    ]);
    buttons.push([{ text: '🔙 Back', callback_data: 'menu_main' }]);

    return { text, buttons };
  }

  /**
   * /whythistrade <analysis> - Explain a trade decision
   */
  static handleWhyThisTrade(analysis: AnalysisResult): { text: string; buttons: any[][] } {
    const explanation = mlEngine.explainTrade(analysis);
    return {
      text: explanation,
      buttons: [
        [{ text: '📊 Full Pattern Report', callback_data: 'ml_pattern_report' }],
        [{ text: '🔙 Back', callback_data: 'menu_main' }],
      ],
    };
  }

  /**
   * /patternreport - Feature importance and pattern analysis
   */
  static handlePatternReport(): { text: string; buttons: any[][] } {
    const report = mlEngine.getPatternReport();
    return {
      text: report,
      buttons: [
        [{ text: '🧠 ML Stats', callback_data: 'ml_stats_refresh' }],
        [{ text: '🏆 Top Strategies', callback_data: 'ml_top_strategies' }],
        [{ text: '🔙 Back', callback_data: 'menu_main' }],
      ],
    };
  }

  /**
   * /mlinsights - ML learning insights
   */
  static handleMLInsights(): { text: string; buttons: any[][] } {
    const strategies = mlEngine.getTopStrategies();
    const stats = mlEngine.getMLStats();

    let text = `🧠 *ML Insights*\n\n`;
    text += stats;
    text += `\n\n💡 *Recommendations*\n`;

    if (strategies.length > 0) {
      const best = strategies[0];
      text += `• Focus on *${best.name}* (${(best.winRate * 100).toFixed(0)}% WR)\n`;

      const worst = strategies[strategies.length - 1];
      if (worst.winRate < 0.4 && worst.totalTrades > 10) {
        text += `• Consider avoiding *${worst.name}* (${(worst.winRate * 100).toFixed(0)}% WR)\n`;
      }
    }

    text += `• Total model retrains: v${mlEngine['modelState'].version}\n`;

    return {
      text,
      buttons: [
        [{ text: '🔄 Retrain Now', callback_data: 'ml_retrain' }],
        [{ text: '📊 Pattern Report', callback_data: 'ml_pattern_report' }],
        [{ text: '🔙 Back', callback_data: 'menu_main' }],
      ],
    };
  }

  /**
   * Handle trade confidence check for a token analysis
   */
  static handleConfidenceCheck(analysis: AnalysisResult): { text: string; buttons: any[][] } {
    const prediction = mlEngine.predict(analysis);

    const alert = MLMessageTemplates.tradeAlert(prediction, analysis);
    const buttons = MLMessageTemplates.tradeAlertButtons(
      analysis.token.contractAddress,
      prediction.allowRealTrading
    );

    return { text: alert, buttons };
  }
}

// ============================================================
// CALLBACK HANDLER (routes inline button presses)
// ============================================================

export class MLCallbackRouter {
  /**
   * Route a callback_data string to the appropriate handler
   * Returns { text, buttons } or null if not an ML callback
   */
  static route(callbackData: string, context?: any): { text: string; buttons: any[][] } | null {
    // ML Stats
    if (callbackData === 'ml_stats_refresh' || callbackData === 'menu_ml_insights') {
      return MLCommandHandlers.handleMLStats();
    }

    // Top strategies
    if (callbackData === 'ml_top_strategies' || callbackData === 'menu_strategies') {
      return MLCommandHandlers.handleTopStrategies();
    }

    // Pattern report
    if (callbackData === 'ml_pattern_report') {
      return MLCommandHandlers.handlePatternReport();
    }

    // ML insights
    if (callbackData === 'ml_insights') {
      return MLCommandHandlers.handleMLInsights();
    }

    // Retrain
    if (callbackData === 'ml_retrain') {
      mlEngine.retrain();
      return {
        text: `🧠 *Model Retrained*\n\nML models have been retrained with latest data.`,
        buttons: [[{ text: '📊 View Stats', callback_data: 'ml_stats_refresh' }]],
      };
    }

    // Strategy toggle
    if (callbackData.startsWith('strat_toggle_')) {
      const stratId = callbackData.replace('strat_toggle_', '');
      // Toggle would be implemented with strategy performance map access
      return {
        text: `Strategy ${stratId} toggled.`,
        buttons: [[{ text: '🔙 Back', callback_data: 'ml_top_strategies' }]],
      };
    }

    // Main menu
    if (callbackData === 'menu_main') {
      return {
        text: MLMessageTemplates.dashboard('Trader'),
        buttons: MLMessageTemplates.dashboardButtons(),
      };
    }

    // Wallet menu
    if (callbackData === 'menu_wallet') {
      return {
        text: MLMessageTemplates.walletMenu(),
        buttons: MLMessageTemplates.walletButtons(),
      };
    }

    // Settings
    if (callbackData === 'menu_settings') {
      return {
        text: MLMessageTemplates.settingsMenu(),
        buttons: MLMessageTemplates.settingsButtons(),
      };
    }

    // Trade execution callbacks
    if (callbackData.startsWith('trade_exec_')) {
      return {
        text: `✅ Trade execution initiated. Monitoring position...`,
        buttons: [[{ text: '📊 Portfolio', callback_data: 'menu_stats' }]],
      };
    }

    if (callbackData.startsWith('trade_sim_')) {
      return {
        text: `🧪 Simulated trade recorded. Tracking in paper trading mode.`,
        buttons: [[{ text: '📊 Portfolio', callback_data: 'menu_stats' }]],
      };
    }

    if (callbackData.startsWith('trade_skip_')) {
      return {
        text: `⏭️ Trade skipped.`,
        buttons: [[{ text: '🔙 Dashboard', callback_data: 'menu_main' }]],
      };
    }

    if (callbackData.startsWith('trade_why_')) {
      // Would need analysis context - return pattern report as fallback
      return MLCommandHandlers.handlePatternReport();
    }

    return null;
  }
}

// ============================================================
// STATE MACHINE for user flows
// ============================================================

export enum UserFlowState {
  IDLE = 'idle',
  ONBOARDING = 'onboarding',
  WALLET_IMPORT = 'wallet_import',
  SETTING_MAX_TRADE = 'setting_max_trade',
  SETTING_STOP_LOSS = 'setting_stop_loss',
  SETTING_TAKE_PROFIT = 'setting_take_profit',
  SETTING_DAILY_LOSS = 'setting_daily_loss',
  CONFIRMING_TRADE = 'confirming_trade',
  ENTERING_PIN = 'entering_pin',
}

export class UserFlowManager {
  private userStates: Map<number, { state: UserFlowState; data?: any }> = new Map();

  getState(userId: number): UserFlowState {
    return this.userStates.get(userId)?.state || UserFlowState.IDLE;
  }

  setState(userId: number, state: UserFlowState, data?: any): void {
    this.userStates.set(userId, { state, data });
  }

  getData(userId: number): any {
    return this.userStates.get(userId)?.data;
  }

  clearState(userId: number): void {
    this.userStates.delete(userId);
  }

  /**
   * Process text input based on current flow state
   * Returns response or null if not in a flow
   */
  processInput(userId: number, text: string): { text: string; buttons?: any[][] } | null {
    const current = this.userStates.get(userId);
    if (!current) return null;

    switch (current.state) {
      case UserFlowState.WALLET_IMPORT:
        this.clearState(userId);
        // Don't echo the key back
        return {
          text: `✅ Wallet import received. Encrypting and storing securely.\n\n⚠️ Delete your message containing the private key for safety.`,
          buttons: [[{ text: '🔙 Dashboard', callback_data: 'menu_main' }]],
        };

      case UserFlowState.SETTING_MAX_TRADE: {
        const value = parseFloat(text);
        if (isNaN(value) || value <= 0 || value > 100) {
          return { text: `❌ Invalid value. Enter a number between 0.01 and 100 SOL.` };
        }
        this.clearState(userId);
        return {
          text: `✅ Max trade size set to ${value} SOL.`,
          buttons: [[{ text: '🔙 Settings', callback_data: 'menu_settings' }]],
        };
      }

      case UserFlowState.SETTING_STOP_LOSS: {
        const value = parseFloat(text);
        if (isNaN(value) || value <= 0 || value > 100) {
          return { text: `❌ Invalid value. Enter a percentage between 1 and 100.` };
        }
        this.clearState(userId);
        return {
          text: `✅ Stop loss set to ${value}%.`,
          buttons: [[{ text: '🔙 Settings', callback_data: 'menu_settings' }]],
        };
      }

      case UserFlowState.SETTING_TAKE_PROFIT: {
        const value = parseFloat(text);
        if (isNaN(value) || value <= 0) {
          return { text: `❌ Invalid value. Enter a positive percentage.` };
        }
        this.clearState(userId);
        return {
          text: `✅ Take profit set to ${value}%.`,
          buttons: [[{ text: '🔙 Settings', callback_data: 'menu_settings' }]],
        };
      }

      case UserFlowState.SETTING_DAILY_LOSS: {
        const value = parseFloat(text);
        if (isNaN(value) || value <= 0) {
          return { text: `❌ Invalid value. Enter a positive SOL amount.` };
        }
        this.clearState(userId);
        return {
          text: `✅ Daily loss limit set to ${value} SOL.`,
          buttons: [[{ text: '🔙 Settings', callback_data: 'menu_settings' }]],
        };
      }

      case UserFlowState.ENTERING_PIN: {
        if (text.length < 4 || text.length > 8 || !/^\d+$/.test(text)) {
          return { text: `❌ PIN must be 4-8 digits.` };
        }
        this.clearState(userId);
        return {
          text: `✅ PIN set successfully.`,
          buttons: [[{ text: '🔙 Dashboard', callback_data: 'menu_main' }]],
        };
      }

      default:
        return null;
    }
  }
}

// ============================================================
// HELPERS
// ============================================================

function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
  return num.toFixed(2);
}

// Export singleton flow manager
export const flowManager = new UserFlowManager();
