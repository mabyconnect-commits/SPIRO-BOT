/**
 * ML Module - Machine Learning Strategy Engine for Solana Trading Bot
 *
 * Exports:
 * - mlEngine: ML Strategy Engine (pattern classification, training, prediction)
 * - MLCommandHandlers: Telegram command handlers for ML endpoints
 * - MLCallbackRouter: Inline button callback router
 * - MLMessageTemplates: Message templates for Telegram UI
 * - flowManager: User flow state machine
 * - secureWallet: Enhanced wallet security manager
 */

export { mlEngine, MLStrategyEngine } from './mlStrategyEngine';
export type {
  MLFeatureVector,
  TradeRecord,
  StrategyPerformance,
  MLPrediction,
  FeatureWeight,
  ModelState,
} from './mlStrategyEngine';

export {
  MLMessageTemplates,
  MLCommandHandlers,
  MLCallbackRouter,
  UserFlowManager,
  UserFlowState,
  flowManager,
} from './telegramMLUI';

export {
  SecureWalletManager,
  secureWallet,
} from './walletSecurity';
export type {
  SecureWalletInfo,
  TransactionSimulation,
  SpendLimits,
} from './walletSecurity';
