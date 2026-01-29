import dotenv from 'dotenv';
import { TradingPreset } from '../types';

dotenv.config();

export const config = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  },
  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    walletPrivateKey: process.env.SOLANA_WALLET_PRIVATE_KEY || '',
  },
  apis: {
    helius: process.env.HELIUS_API_KEY || '',
    birdeye: process.env.BIRDEYE_API_KEY || '',
  },
  trading: {
    paperTrading: process.env.PAPER_TRADING === 'true',
    defaultPreset: process.env.DEFAULT_PRESET || 'balanced',
    maxPositionSizeSol: parseFloat(process.env.MAX_POSITION_SIZE_SOL || '1.0'),
    slippageBps: parseInt(process.env.SLIPPAGE_BPS || '100'),
  },
  paperTrading: {
    initialBalance: parseFloat(process.env.PAPER_INITIAL_BALANCE || '100'),
    defaultTradeSize: parseFloat(process.env.PAPER_DEFAULT_TRADE_SIZE || '0.35'),
    highConfidenceTradeSize: parseFloat(process.env.PAPER_HIGH_CONFIDENCE_TRADE_SIZE || '0.5'),
    highConfidenceThreshold: parseFloat(process.env.HIGH_CONFIDENCE_THRESHOLD || '0.75'),
  },
  scanner: {
    scanIntervalMs: parseInt(process.env.SCAN_INTERVAL_MS || '120000'), // 2 minutes default
    minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD || '10000'),
    minVolume24hUsd: parseFloat(process.env.MIN_VOLUME_24H_USD || '50000'),
    mandatoryBuySignalIntervalMs: parseInt(process.env.MANDATORY_BUY_SIGNAL_INTERVAL_MS || '300000'), // 5 minutes

    // Market cap filters (configurable low/high cap ranges)
    marketCapFilters: {
      // Low cap: $3k - $100k (high risk, high reward)
      lowCap: {
        enabled: process.env.LOW_CAP_ENABLED !== 'false',
        minMarketCapUsd: parseFloat(process.env.LOW_CAP_MIN_MC_USD || '3000'),       // >= $3k
        maxMarketCapUsd: parseFloat(process.env.LOW_CAP_MAX_MC_USD || '100000'),     // <= $100k
        minLiquidityUsd: parseFloat(process.env.LOW_CAP_MIN_LIQ_USD || '3000'),
        positionSizeMultiplier: parseFloat(process.env.LOW_CAP_POSITION_MULT || '0.5'), // Smaller positions
      },
      // Mid cap: $100k - $1M (moderate risk)
      midCap: {
        enabled: process.env.MID_CAP_ENABLED !== 'false',
        minMarketCapUsd: parseFloat(process.env.MID_CAP_MIN_MC_USD || '100000'),     // >= $100k
        maxMarketCapUsd: parseFloat(process.env.MID_CAP_MAX_MC_USD || '1000000'),    // <= $1M
        minLiquidityUsd: parseFloat(process.env.MID_CAP_MIN_LIQ_USD || '10000'),
        positionSizeMultiplier: parseFloat(process.env.MID_CAP_POSITION_MULT || '1.0'),
      },
      // High cap: $1M+ (lower risk, more stable)
      highCap: {
        enabled: process.env.HIGH_CAP_ENABLED !== 'false',
        minMarketCapUsd: parseFloat(process.env.HIGH_CAP_MIN_MC_USD || '1000000'),   // >= $1M
        maxMarketCapUsd: parseFloat(process.env.HIGH_CAP_MAX_MC_USD || '50000000'),  // <= $50M (configurable)
        minLiquidityUsd: parseFloat(process.env.HIGH_CAP_MIN_LIQ_USD || '50000'),
        positionSizeMultiplier: parseFloat(process.env.HIGH_CAP_POSITION_MULT || '1.5'), // Larger positions OK
      },
    },

    // New pairs scanning config (very fresh tokens)
    newPairs: {
      enabled: process.env.NEW_PAIRS_ENABLED !== 'false', // Enabled by default
      scanIntervalMs: parseInt(process.env.NEW_PAIRS_SCAN_INTERVAL_MS || '30000'), // 30 seconds for new pairs
      minLiquidityUsd: parseFloat(process.env.NEW_PAIRS_MIN_LIQUIDITY_USD || '3000'), // $3k min for new tokens
      maxLiquidityUsd: parseFloat(process.env.NEW_PAIRS_MAX_LIQUIDITY_USD || '50000'), // $50k max (filter out established tokens)
      minMarketCapUsd: parseFloat(process.env.NEW_PAIRS_MIN_MC_USD || '3000'), // $3k min MC
      maxMarketCapUsd: parseFloat(process.env.NEW_PAIRS_MAX_MC_USD || '100000'), // $100k max MC (catches 3k-100k range)
      maxAgeMinutes: parseInt(process.env.NEW_PAIRS_MAX_AGE_MINUTES || '30'), // Only tokens < 30 min old
    },
    // Position monitoring
    positionUpdateIntervalMs: parseInt(process.env.POSITION_UPDATE_INTERVAL_MS || '60000'), // Update positions every 1 minute
  },
  subscription: {
    freeAdminUsername: process.env.FREE_ADMIN_USERNAME || 'mabyconnect2000',
    priceSol: parseFloat(process.env.SUBSCRIPTION_PRICE_SOL || '0.5'),
    durationDays: parseInt(process.env.SUBSCRIPTION_DURATION_DAYS || '30'),
    mainWallet: process.env.MAIN_WALLET || 'EAi7pueCbhkioMb8kHtib2hrVWvTkhkPpNq4saHQfhFy',
  },
  learning: {
    enabled: process.env.LEARNING_ENABLED === 'true',
    minPatternConfidence: parseFloat(process.env.MIN_PATTERN_CONFIDENCE || '0.6'),
    antiDriftThreshold: parseFloat(process.env.ANTI_DRIFT_THRESHOLD || '0.15'),
  },
  database: {
    path: process.env.DB_PATH || './data/alpha-hunter.db',
  },
  security: {
    encryptionKey: process.env.WALLET_ENCRYPTION_KEY || 'default-key-change-in-production-32b',
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || './logs/alpha-hunter.log',
  },
};

export const TRADING_PRESETS: Record<string, TradingPreset> = {
  conservative: {
    name: 'Conservative',
    description: 'Low risk, high confidence only',
    maxPositionSizeSol: 0.5,
    minConfidence: 0.85,
    takeProfitPercentage: 50,
    stopLossPercentage: 15,
    maxOpenPositions: 3,
    riskLevel: 'conservative',
  },
  moderate: {
    name: 'Moderate',
    description: 'Balanced risk/reward',
    maxPositionSizeSol: 1.0,
    minConfidence: 0.75,
    takeProfitPercentage: 100,
    stopLossPercentage: 25,
    maxOpenPositions: 5,
    riskLevel: 'moderate',
  },
  balanced: {
    name: 'Balanced',
    description: 'Standard runner hunting',
    maxPositionSizeSol: 1.5,
    minConfidence: 0.65,
    takeProfitPercentage: 150,
    stopLossPercentage: 30,
    maxOpenPositions: 7,
    riskLevel: 'balanced',
  },
  aggressive: {
    name: 'Aggressive',
    description: 'Higher risk for higher returns',
    maxPositionSizeSol: 2.5,
    minConfidence: 0.55,
    takeProfitPercentage: 300,
    stopLossPercentage: 40,
    maxOpenPositions: 10,
    riskLevel: 'aggressive',
  },
  degen: {
    name: 'Degen',
    description: 'YOLO mode - maximum risk',
    maxPositionSizeSol: 5.0,
    minConfidence: 0.45,
    takeProfitPercentage: 500,
    stopLossPercentage: 50,
    maxOpenPositions: 15,
    riskLevel: 'degen',
  },
};

export const RUNNER_PATTERNS: any[] = [
  {
    id: 'smart_money_entry',
    name: 'Smart Money Entry',
    description: 'Known winning wallets accumulating',
    signals: [
      { type: 'wallet', metric: 'isSmartMoney', operator: 'eq', value: 1, weight: 0.4 },
      { type: 'wallet', metric: 'profitRate', operator: 'gte', value: 0.7, weight: 0.3 },
      { type: 'technical', metric: 'volumeBreakout', operator: 'eq', value: 1, weight: 0.3 },
    ],
  },
  {
    id: 'volume_breakout',
    name: 'Volume Breakout',
    description: 'Massive volume spike with strong momentum',
    signals: [
      { type: 'technical', metric: 'volumeBreakout', operator: 'eq', value: 1, weight: 0.5 },
      { type: 'technical', metric: 'priceAction', operator: 'eq', value: 1, weight: 0.3 },
      { type: 'fundamental', metric: 'liquidityScore', operator: 'gte', value: 0.7, weight: 0.2 },
    ],
  },
  {
    id: 'fresh_launch',
    name: 'Fresh Launch',
    description: 'New token with strong fundamentals',
    signals: [
      { type: 'fundamental', metric: 'tokenAge', operator: 'lte', value: 24, weight: 0.3 },
      { type: 'fundamental', metric: 'liquidityLocked', operator: 'eq', value: 1, weight: 0.3 },
      { type: 'fundamental', metric: 'uniqueHolders', operator: 'gte', value: 100, weight: 0.2 },
      { type: 'social', metric: 'trendingScore', operator: 'gte', value: 0.6, weight: 0.2 },
    ],
  },
  {
    id: 'whale_accumulation',
    name: 'Whale Accumulation',
    description: 'Large holders steadily buying',
    signals: [
      { type: 'wallet', metric: 'isWhale', operator: 'eq', value: 1, weight: 0.5 },
      { type: 'technical', metric: 'priceAction', operator: 'eq', value: 1, weight: 0.3 },
      { type: 'fundamental', metric: 'topHolderPercentage', operator: 'lte', value: 30, weight: 0.2 },
    ],
  },
  {
    id: 'social_momentum',
    name: 'Social Momentum',
    description: 'Viral on CT with strong community',
    signals: [
      { type: 'social', metric: 'twitterMentions', operator: 'gte', value: 100, weight: 0.3 },
      { type: 'social', metric: 'influencerEngagement', operator: 'gte', value: 5, weight: 0.3 },
      { type: 'social', metric: 'sentiment', operator: 'eq', value: 1, weight: 0.2 },
      { type: 'fundamental', metric: 'uniqueHolders', operator: 'gte', value: 500, weight: 0.2 },
    ],
  },
  {
    id: 'stealth_accumulation',
    name: 'Stealth Accumulation',
    description: 'Low-key buying before breakout',
    signals: [
      { type: 'wallet', metric: 'isSmartMoney', operator: 'eq', value: 1, weight: 0.4 },
      { type: 'technical', metric: 'volatility', operator: 'lte', value: 0.3, weight: 0.3 },
      { type: 'fundamental', metric: 'holderConcentration', operator: 'gte', value: 0.6, weight: 0.3 },
    ],
  },
  {
    id: 'dev_locked',
    name: 'Dev Locked & Loaded',
    description: 'Dev wallet locked, liquidity secured',
    signals: [
      { type: 'fundamental', metric: 'devWalletLocked', operator: 'eq', value: 1, weight: 0.4 },
      { type: 'fundamental', metric: 'liquidityLocked', operator: 'eq', value: 1, weight: 0.4 },
      { type: 'social', metric: 'sentiment', operator: 'eq', value: 1, weight: 0.2 },
    ],
  },
];
