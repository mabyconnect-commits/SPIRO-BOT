export interface TokenData {
  contractAddress: string;
  symbol: string;
  name: string;
  price: number;
  priceChange24h: number;
  volume24h: number;
  liquidity: number;
  marketCap: number;
  holders: number;
  createdAt: Date;
  dexScreenerData?: any;
  birdeyeData?: any;
}

export interface WalletSignal {
  isSmartMoney: boolean;
  isWhale: boolean;
  isKnownWinner: boolean;
  walletAge: number;
  profitRate: number;
  recentWins: number;
}

export interface TechnicalSignal {
  volumeBreakout: boolean;
  liquidityScore: number;
  priceAction: 'bullish' | 'bearish' | 'neutral';
  rsi: number;
  volatility: number;
}

export interface FundamentalSignal {
  holderConcentration: number;
  topHolderPercentage: number;
  uniqueHolders: number;
  devWalletLocked: boolean;
  liquidityLocked: boolean;
  tokenAge: number;
}

export interface SocialSignal {
  twitterMentions: number;
  influencerEngagement: number;
  sentiment: 'positive' | 'negative' | 'neutral';
  trendingScore: number;
}

export interface AnalysisResult {
  token: TokenData;
  walletSignals: WalletSignal[];
  technical: TechnicalSignal;
  fundamental: FundamentalSignal;
  social: SocialSignal;
  overallScore: number;
  confidence: number;
  recommendation: 'strong_buy' | 'buy' | 'hold' | 'avoid';
  matchedPatterns: RunnerPattern[];
  reasoning: string;
  // Enhanced metrics (optional for backwards compatibility)
  enhancedMetrics?: EnhancedTokenMetrics;
}

export interface RunnerPattern {
  id: string;
  name: string;
  description: string;
  signals: PatternSignal[];
  confidence: number;
  successRate: number;
  avgReturn: number;
  sampleSize: number;
}

export interface PatternSignal {
  type: 'wallet' | 'technical' | 'fundamental' | 'social';
  metric: string;
  operator: 'gt' | 'lt' | 'eq' | 'gte' | 'lte' | 'between';
  value: number;
  weight: number;
}

export interface TradePosition {
  id: string;
  userId: number;
  contractAddress: string;
  symbol: string;
  entryPrice: number;
  currentPrice: number;
  amount: number;
  solInvested: number;
  pnl: number;
  pnlPercentage: number;
  openedAt: Date;
  closedAt?: Date;
  status: 'open' | 'closed';
  type: 'paper' | 'real';
}

export interface TradingPreset {
  name: string;
  description: string;
  maxPositionSizeSol: number;
  minConfidence: number;
  takeProfitPercentage: number;
  stopLossPercentage: number;
  maxOpenPositions: number;
  riskLevel: 'conservative' | 'moderate' | 'balanced' | 'aggressive' | 'degen';
}

export interface UserSettings {
  userId: number;
  telegramUsername?: string;
  preset: string;
  paperTrading: boolean;
  autoTrade: boolean;
  alertThreshold: number;
  notificationsEnabled: boolean;
  paperBalance: number;
  defaultTradeSize: number;
  highConfidenceTradeSize: number;
  takeProfitPercentage: number;
  stopLossPercentage: number;
  isSubscribed: boolean;
  subscriptionExpiresAt?: Date;
  customPatterns: string[];
}

export interface TokenLore {
  contractAddress: string;
  symbol: string;
  name: string;
  lore: string;
  narrativeStrength: number;
  isBuy: boolean;
  buyReason?: string;
  notBuyReason?: string;
  analyzedAt: Date;
}

export interface SubscriptionPayment {
  id: number;
  userId: number;
  paymentWallet: string;
  amountSol: number;
  status: 'pending' | 'confirmed' | 'failed';
  createdAt: Date;
  confirmedAt?: Date;
}

export interface ScannerConfig {
  scanIntervalMs: number;
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  maxTokenAgeDays: number;
  minHolders: number;
}

export interface LearningData {
  patternId: string;
  tradeId: string;
  outcome: 'win' | 'loss';
  returnPercentage: number;
  entrySignals: any;
  timestamp: Date;
}

// On-chain holder tracking types
export interface HolderInfo {
  address: string;
  balance: number;
  percentage: number;
  isWhale: boolean;      // Holds > 2% of supply
  isSmartMoney: boolean; // Known profitable wallet
}

export interface HolderDistribution {
  totalHolders: number;
  top10Percentage: number;
  top20Percentage: number;
  top50Percentage: number;
  whaleCount: number;       // Wallets holding > 2%
  retailCount: number;      // Wallets holding < 0.1%
  concentration: 'high' | 'medium' | 'low'; // Based on top 10 %
  topHolders: HolderInfo[];
}

export interface HolderSnapshot {
  contractAddress: string;
  timestamp: Date;
  distribution: HolderDistribution;
}

export interface HolderChange {
  address: string;
  previousBalance: number;
  newBalance: number;
  changeAmount: number;
  changePercent: number;
  action: 'buy' | 'sell' | 'new' | 'exit';
  isWhale: boolean;
  timestamp: Date;
}

export interface HolderAnalysis {
  distribution: HolderDistribution;
  recentChanges: HolderChange[];
  signals: {
    whaleAccumulating: boolean;
    smartMoneyEntering: boolean;
    retailFomo: boolean;
    distributionImproving: boolean;
    dangerousConcentration: boolean;
  };
  score: number; // 0-100 holder health score
}

// ============================================================
// ENHANCED TRACKING TYPES
// ============================================================

/**
 * Dev wallet behavior tracking
 */
export interface DevWalletBehavior {
  devWalletAddress: string | null;
  totalBalance: number;
  percentageOfSupply: number;
  recentSells: number;           // Sells in last 24h
  sellPressure: number;          // 0-1 score (higher = more selling)
  lastActivity: Date | null;
  isActive: boolean;             // Has activity in last 24h
  isDumping: boolean;            // Selling large amounts
  holdingDuration: number;       // Hours since first acquired
  suspiciousActivity: boolean;   // Red flag patterns
}

/**
 * Buy/sell pressure metrics
 */
export interface BuySellPressure {
  buys1h: number;
  sells1h: number;
  buys6h: number;
  sells6h: number;
  buys24h: number;
  sells24h: number;
  buyVolume24h: number;
  sellVolume24h: number;
  buyToSellRatio: number;        // buys / sells (>1 = bullish)
  volumeRatio: number;           // buyVolume / sellVolume
  netFlow: number;               // buyVolume - sellVolume (positive = inflow)
  pressure: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell';
  momentum: 'accelerating' | 'stable' | 'decelerating';
}

/**
 * Transaction velocity tracking
 */
export interface TransactionVelocity {
  txns1m: number;                // Transactions in last 1 minute
  txns5m: number;                // Transactions in last 5 minutes
  txns1h: number;                // Transactions in last 1 hour
  txns6h: number;                // Transactions in last 6 hours
  txns24h: number;               // Transactions in last 24 hours
  avgTxSize: number;             // Average transaction size in USD
  velocityScore: number;         // 0-100 normalized velocity
  velocityTrend: 'increasing' | 'stable' | 'decreasing';
  isSpike: boolean;              // Abnormal activity detected
  uniqueWallets24h: number;      // Unique wallets transacting
}

/**
 * Enhanced token metrics combining all tracking data
 */
export interface EnhancedTokenMetrics {
  devWallet: DevWalletBehavior;
  buySellPressure: BuySellPressure;
  transactionVelocity: TransactionVelocity;
  overallHealthScore: number;    // 0-100 composite score
  riskFlags: string[];           // List of detected risks
  bullishSignals: string[];      // List of bullish indicators
}

/**
 * Market cap tier configuration
 */
export interface MarketCapTierConfig {
  name: string;
  minMarketCap: number;
  maxMarketCap: number;
  minLiquidity: number;
  positionSizeMultiplier: number;
  riskMultiplier: number;
}

/**
 * Scanner filter configuration
 */
export interface ScannerFilters {
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  minLiquidityUsd: number;
  maxLiquidityUsd: number;
  minVolume24hUsd: number;
  minHolders: number;
  maxTokenAgeHours: number;
  requireLiquidityLock: boolean;
  excludeRugPull: boolean;
}
