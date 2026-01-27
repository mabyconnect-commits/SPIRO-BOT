/**
 * Telegram Command Integration - New commands for all modules
 *
 * Adds these commands to the existing bot:
 * /stats - Full trading statistics
 * /strategies - Strategy performance dashboard
 * /simulation - Simulation engine report
 * /leaderboard - User rankings
 * /profits - Profit/loss report
 * /risk - Risk manager status
 * /mlstats - ML engine statistics
 * /topstrategies - Top ranked strategies
 * /whythistrade <token> - Explainable AI
 * /patternreport - Feature importance analysis
 * /killswitch - Emergency stop
 * /blacklist - View/manage blacklist
 * /systemstatus - Full system overview
 */

import { analyticsEngine } from '../analytics/analyticsEngine';
import { strategyEngine } from '../strategy/strategyEngine';
import { simulationEngine } from '../simulation/simulationEngine';
import { riskManager } from '../risk/riskManager';
import { mlEngine } from '../ml/mlStrategyEngine';
import { MLCommandHandlers, MLCallbackRouter } from '../ml/telegramMLUI';
import { pipeline } from './pipelineIntegration';
import tokenAnalyzer from '../analyzer/tokenAnalyzer';
import logger from '../utils/logger';

// ============================================================
// TYPES
// ============================================================

export interface CommandResult {
  text: string;
  buttons?: any[][];
  parseMode?: 'Markdown' | 'HTML';
}

// ============================================================
// COMMAND HANDLER REGISTRY
// ============================================================

export class TelegramCommandRegistry {

  // ---- /stats ----
  static handleStats(userId: number): CommandResult {
    return {
      text: analyticsEngine.generateStatsReport(userId),
      buttons: [
        [
          { text: '💰 Profits', callback_data: 'cmd_profits' },
          { text: '🧪 Simulation', callback_data: 'cmd_simulation' },
        ],
        [
          { text: '🤖 Strategies', callback_data: 'cmd_strategies' },
          { text: '🏆 Leaderboard', callback_data: 'cmd_leaderboard' },
        ],
        [{ text: '🔄 Refresh', callback_data: 'cmd_stats' }],
      ],
    };
  }

  // ---- /strategies ----
  static handleStrategies(): CommandResult {
    const report = strategyEngine.generateReport();
    const stratAnalytics = analyticsEngine.generateStrategiesReport();

    return {
      text: report + '\n' + stratAnalytics,
      buttons: [
        [
          { text: '🏆 Top Ranked', callback_data: 'cmd_topstrategies' },
          { text: '🧪 Simulation', callback_data: 'cmd_simulation' },
        ],
        [
          { text: '🧠 ML Insights', callback_data: 'cmd_mlstats' },
          { text: '📊 Pattern Report', callback_data: 'cmd_patternreport' },
        ],
      ],
    };
  }

  // ---- /simulation ----
  static handleSimulation(): CommandResult {
    return {
      text: analyticsEngine.generateSimulationReport(),
      buttons: [
        [{ text: '📊 Stats', callback_data: 'cmd_stats' }],
        [{ text: '🤖 Strategies', callback_data: 'cmd_strategies' }],
      ],
    };
  }

  // ---- /leaderboard ----
  static handleLeaderboard(): CommandResult {
    return {
      text: analyticsEngine.generateLeaderboardReport(),
      buttons: [
        [{ text: '📊 My Stats', callback_data: 'cmd_stats' }],
        [{ text: '🔄 Refresh', callback_data: 'cmd_leaderboard' }],
      ],
    };
  }

  // ---- /profits ----
  static handleProfits(userId: number): CommandResult {
    return {
      text: analyticsEngine.generateProfitsReport(userId),
      buttons: [
        [
          { text: '📊 Full Stats', callback_data: 'cmd_stats' },
          { text: '🏆 Leaderboard', callback_data: 'cmd_leaderboard' },
        ],
      ],
    };
  }

  // ---- /risk ----
  static handleRisk(userId: number): CommandResult {
    return {
      text: riskManager.generateReport(userId),
      buttons: [
        [
          { text: '🔴 Kill Switch', callback_data: 'cmd_killswitch_toggle' },
          { text: '📋 Blacklist', callback_data: 'cmd_blacklist' },
        ],
        [{ text: '🔙 Dashboard', callback_data: 'menu_main' }],
      ],
    };
  }

  // ---- /mlstats ----
  static handleMLStats(): CommandResult {
    return MLCommandHandlers.handleMLStats();
  }

  // ---- /topstrategies ----
  static handleTopStrategies(): CommandResult {
    return MLCommandHandlers.handleTopStrategies();
  }

  // ---- /whythistrade <address> ----
  static async handleWhyThisTrade(contractAddress: string): Promise<CommandResult> {
    try {
      const analysis = await tokenAnalyzer.analyzeToken(contractAddress);
      if (!analysis) {
        return { text: `❌ Could not analyze token: ${contractAddress}` };
      }
      return MLCommandHandlers.handleWhyThisTrade(analysis);
    } catch (error) {
      return { text: `❌ Error analyzing token: ${error}` };
    }
  }

  // ---- /patternreport ----
  static handlePatternReport(): CommandResult {
    return MLCommandHandlers.handlePatternReport();
  }

  // ---- /killswitch ----
  static handleKillSwitch(): CommandResult {
    const isActive = riskManager.isKillSwitchActive();
    return {
      text: isActive
        ? `🔴 *Kill Switch is ACTIVE*\n\nAll trading is disabled. Deactivate to resume.`
        : `🟢 *Kill Switch is OFF*\n\nTrading is operational.`,
      buttons: [
        [{
          text: isActive ? '🟢 Deactivate Kill Switch' : '🔴 Activate Kill Switch',
          callback_data: 'cmd_killswitch_toggle',
        }],
        [{ text: '🔙 Back', callback_data: 'cmd_risk' }],
      ],
    };
  }

  // ---- /blacklist ----
  static handleBlacklist(): CommandResult {
    const entries = riskManager.getBlacklist();
    let text = `📋 *Blacklisted Tokens*\n\n`;

    if (entries.length === 0) {
      text += `No tokens blacklisted.\n`;
    } else {
      entries.slice(0, 20).forEach((e, i) => {
        const severity = e.severity === 'block' ? '🔴' : '🟡';
        text += `${i + 1}. ${severity} \`${e.contractAddress.substring(0, 8)}...\`\n   ${e.reason}\n`;
      });
      if (entries.length > 20) {
        text += `\n... and ${entries.length - 20} more`;
      }
    }

    return {
      text,
      buttons: [[{ text: '🔙 Back', callback_data: 'cmd_risk' }]],
    };
  }

  // ---- /systemstatus ----
  static handleSystemStatus(): CommandResult {
    const status = pipeline.getSystemStatus();
    const mlReport = analyticsEngine.generateMLReport();

    return {
      text: status + '\n' + mlReport,
      buttons: [
        [
          { text: '📊 Stats', callback_data: 'cmd_stats' },
          { text: '🛡️ Risk', callback_data: 'cmd_risk' },
        ],
        [
          { text: '🤖 Strategies', callback_data: 'cmd_strategies' },
          { text: '🧪 Simulation', callback_data: 'cmd_simulation' },
        ],
      ],
    };
  }

  // ============================================================
  // CALLBACK ROUTER
  // ============================================================

  static async routeCallback(callbackData: string, userId: number): Promise<CommandResult | null> {
    // ML callbacks first
    const mlResult = MLCallbackRouter.route(callbackData);
    if (mlResult) return mlResult;

    // Module callbacks
    switch (callbackData) {
      case 'cmd_stats':
        return this.handleStats(userId);
      case 'cmd_strategies':
        return this.handleStrategies();
      case 'cmd_simulation':
        return this.handleSimulation();
      case 'cmd_leaderboard':
        return this.handleLeaderboard();
      case 'cmd_profits':
        return this.handleProfits(userId);
      case 'cmd_risk':
        return this.handleRisk(userId);
      case 'cmd_mlstats':
        return this.handleMLStats();
      case 'cmd_topstrategies':
        return this.handleTopStrategies();
      case 'cmd_patternreport':
        return this.handlePatternReport();
      case 'cmd_blacklist':
        return this.handleBlacklist();
      case 'cmd_systemstatus':
        return this.handleSystemStatus();

      case 'cmd_killswitch_toggle': {
        if (riskManager.isKillSwitchActive()) {
          riskManager.deactivateKillSwitch();
        } else {
          riskManager.activateKillSwitch();
        }
        return this.handleKillSwitch();
      }

      default:
        return null;
    }
  }
}

export default TelegramCommandRegistry;
