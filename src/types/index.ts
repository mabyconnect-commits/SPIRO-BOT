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
  operator: 'gt' | 'lt' | 'eq' | 'gte' | 'lte';
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
