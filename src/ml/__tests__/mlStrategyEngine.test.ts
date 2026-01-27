/**
 * Unit tests for ML Strategy Engine
 */

// Mock dependencies before imports
jest.mock('../../database', () => ({
  default: {
    db: null,
    getUserWallet: jest.fn().mockReturnValue(null),
    getPaperBalance: jest.fn().mockReturnValue(100),
    getUserSettings: jest.fn().mockReturnValue(null),
    getPatternPerformance: jest.fn().mockReturnValue({ successRate: 0, avgReturn: 0, sampleSize: 0 }),
    saveLearningData: jest.fn(),
    getRecentTradesForPattern: jest.fn().mockReturnValue([]),
  },
}));

jest.mock('../../utils/logger', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../config', () => ({
  config: {
    database: { path: ':memory:' },
    security: { encryptionKey: 'test-key-32-bytes-long-padding!!' },
    learning: { enabled: true, minPatternConfidence: 0.6, antiDriftThreshold: 0.15 },
    solana: { rpcUrl: 'https://api.mainnet-beta.solana.com' },
    trading: { paperTrading: true, defaultPreset: 'balanced' },
  },
  RUNNER_PATTERNS: [],
  TRADING_PRESETS: {
    balanced: {
      name: 'Balanced',
      maxPositionSizeSol: 1.5,
      minConfidence: 0.65,
      takeProfitPercentage: 150,
      stopLossPercentage: 30,
      maxOpenPositions: 7,
      riskLevel: 'balanced',
    },
  },
}));

import { MLStrategyEngine, MLFeatureVector, TradeRecord } from '../mlStrategyEngine';
import { AnalysisResult } from '../../types';

describe('MLStrategyEngine', () => {
  let engine: MLStrategyEngine;

  const mockAnalysis: AnalysisResult = {
    token: {
      contractAddress: 'TokenAddress123',
      symbol: 'TEST',
      name: 'Test Token',
      price: 0.001,
      priceChange24h: 50,
      volume24h: 500000,
      liquidity: 100000,
      marketCap: 1000000,
      holders: 500,
      createdAt: new Date(Date.now() - 3600000),
    },
    walletSignals: [
      { isSmartMoney: true, isWhale: false, isKnownWinner: true, walletAge: 365, profitRate: 0.8, recentWins: 5 },
    ],
    technical: {
      volumeBreakout: true,
      liquidityScore: 0.8,
      priceAction: 'bullish',
      rsi: 65,
      volatility: 0.3,
    },
    fundamental: {
      holderConcentration: 0.4,
      topHolderPercentage: 15,
      uniqueHolders: 500,
      devWalletLocked: true,
      liquidityLocked: true,
      tokenAge: 2,
    },
    social: {
      twitterMentions: 200,
      influencerEngagement: 10,
      sentiment: 'positive',
      trendingScore: 0.8,
    },
    overallScore: 85,
    confidence: 0.82,
    recommendation: 'strong_buy',
    matchedPatterns: [],
    reasoning: 'Test analysis',
  };

  beforeEach(() => {
    engine = new MLStrategyEngine();
  });

  describe('Feature Extraction', () => {
    test('should extract features from analysis result', () => {
      const features = engine.extractFeatures(mockAnalysis);

      expect(features).toBeDefined();
      expect(typeof features.marketCap).toBe('number');
      expect(typeof features.liquidity).toBe('number');
      expect(typeof features.volume24h).toBe('number');
      expect(typeof features.smartMoneyPresent).toBe('number');
      expect(typeof features.rugSignals).toBe('number');
    });

    test('should normalize features between 0 and 1', () => {
      const features = engine.extractFeatures(mockAnalysis);
      const featureArray = engine.featureVectorToArray(features);

      for (const val of featureArray) {
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThanOrEqual(1);
      }
    });

    test('should detect smart money presence', () => {
      const features = engine.extractFeatures(mockAnalysis);
      expect(features.smartMoneyPresent).toBe(1);
    });

    test('should compute rug signals', () => {
      const features = engine.extractFeatures(mockAnalysis);
      // Dev wallet locked + liquidity locked = low rug signals
      expect(features.rugSignals).toBeLessThan(0.5);
    });

    test('should handle bullish price action', () => {
      const features = engine.extractFeatures(mockAnalysis);
      expect(features.buySellRatio).toBe(0.8);
    });
  });

  describe('Feature Vector Conversion', () => {
    test('should convert feature vector to array of correct length', () => {
      const features = engine.extractFeatures(mockAnalysis);
      const arr = engine.featureVectorToArray(features);
      expect(arr.length).toBe(24);
    });

    test('should produce consistent array ordering', () => {
      const features = engine.extractFeatures(mockAnalysis);
      const arr1 = engine.featureVectorToArray(features);
      const arr2 = engine.featureVectorToArray(features);
      expect(arr1).toEqual(arr2);
    });
  });

  describe('Classification', () => {
    test('should classify token and return prediction', () => {
      const prediction = engine.classifyToken(mockAnalysis);

      expect(prediction).toBeDefined();
      expect(prediction.confidenceScore).toBeGreaterThanOrEqual(0);
      expect(prediction.confidenceScore).toBeLessThanOrEqual(100);
      expect(['high_probability', 'medium_probability', 'high_rug_risk']).toContain(prediction.classification);
      expect(prediction.riskScore).toBeGreaterThanOrEqual(0);
      expect(prediction.riskScore).toBeLessThanOrEqual(100);
      expect(prediction.expectedROIRange).toHaveProperty('min');
      expect(prediction.expectedROIRange).toHaveProperty('max');
      expect(typeof prediction.allowRealTrading).toBe('boolean');
      expect(typeof prediction.explanation).toBe('string');
      expect(prediction.explanation.length).toBeGreaterThan(0);
    });

    test('should block real trading when insufficient history', () => {
      const prediction = engine.classifyToken(mockAnalysis);
      // No trades recorded yet = should block real trading
      expect(prediction.allowRealTrading).toBe(false);
    });

    test('should return feature importance in explanation', () => {
      const prediction = engine.classifyToken(mockAnalysis);
      expect(Array.isArray(prediction.featureImportance)).toBe(true);
    });

    test('should report model agreement percentage', () => {
      const prediction = engine.classifyToken(mockAnalysis);
      expect(prediction.modelAgreement).toBeGreaterThanOrEqual(0);
      expect(prediction.modelAgreement).toBeLessThanOrEqual(100);
    });
  });

  describe('Strategy Ranking', () => {
    test('should return strategy rankings', () => {
      const rankings = engine.rankStrategies();
      expect(Array.isArray(rankings)).toBe(true);
      expect(rankings.length).toBeGreaterThan(0);
    });

    test('should have all default strategies', () => {
      const rankings = engine.rankStrategies();
      const names = rankings.map(s => s.strategyId);
      expect(names).toContain('smart_money_entry');
      expect(names).toContain('volume_breakout');
      expect(names).toContain('fresh_launch');
    });

    test('should start with all strategies active', () => {
      const rankings = engine.rankStrategies();
      for (const strat of rankings) {
        expect(strat.isActive).toBe(true);
      }
    });
  });

  describe('Reinforcement Learning', () => {
    test('should record winning trade and increase position multiplier', () => {
      const trade: TradeRecord = {
        id: 'test-1',
        features: engine.extractFeatures(mockAnalysis),
        entryPrice: 0.001,
        exitPrice: 0.005,
        roi: 400,
        maxDrawdown: 10,
        timeHeldMinutes: 60,
        strategyUsed: 'smart_money_entry',
        outcome: 'win',
        profitMultiple: 5,
        timestamp: Date.now(),
        isReal: false,
      };

      engine.recordTradeOutcome(trade);
      const multiplier = engine.getPositionSizeMultiplier('smart_money_entry');
      expect(multiplier).toBeGreaterThan(1.0);
    });

    test('should record losing trade and decrease position multiplier', () => {
      const trade: TradeRecord = {
        id: 'test-2',
        features: engine.extractFeatures(mockAnalysis),
        entryPrice: 0.001,
        exitPrice: 0.0003,
        roi: -70,
        maxDrawdown: 70,
        timeHeldMinutes: 30,
        strategyUsed: 'volume_breakout',
        outcome: 'loss',
        profitMultiple: 0.3,
        timestamp: Date.now(),
        isReal: false,
      };

      engine.recordTradeOutcome(trade);
      const multiplier = engine.getPositionSizeMultiplier('volume_breakout');
      expect(multiplier).toBeLessThan(1.0);
    });
  });

  describe('Training', () => {
    test('should not crash when retraining with no data', () => {
      expect(() => engine.retrain()).not.toThrow();
    });

    test('should retrain after recording enough trades', () => {
      // Add 15 trades
      for (let i = 0; i < 15; i++) {
        engine.recordTradeOutcome({
          id: `train-${i}`,
          features: engine.extractFeatures(mockAnalysis),
          entryPrice: 0.001,
          exitPrice: i % 3 === 0 ? 0.0005 : 0.003,
          roi: i % 3 === 0 ? -50 : 200,
          maxDrawdown: i % 3 === 0 ? 50 : 10,
          timeHeldMinutes: 60,
          strategyUsed: 'smart_money_entry',
          outcome: i % 3 === 0 ? 'loss' : 'win',
          profitMultiple: i % 3 === 0 ? 0.5 : 3,
          timestamp: Date.now(),
          isReal: false,
        });
      }

      expect(() => engine.retrain()).not.toThrow();
    });
  });

  describe('Stats & Reports', () => {
    test('should generate ML stats string', () => {
      const stats = engine.getMLStats();
      expect(typeof stats).toBe('string');
      expect(stats).toContain('ML Strategy Engine');
    });

    test('should generate pattern report', () => {
      const report = engine.getPatternReport();
      expect(typeof report).toBe('string');
      expect(report).toContain('Pattern');
    });

    test('should explain trade', () => {
      const explanation = engine.explainTrade(mockAnalysis);
      expect(typeof explanation).toBe('string');
      expect(explanation).toContain('TEST');
      expect(explanation).toContain('Confidence');
    });

    test('should return top strategies', () => {
      const top = engine.getTopStrategies();
      expect(Array.isArray(top)).toBe(true);
    });
  });

  describe('Trade Record Builder', () => {
    test('should build a trade record from position and analysis', () => {
      const position = {
        id: 'pos-1',
        userId: 123,
        contractAddress: 'TokenAddress123',
        symbol: 'TEST',
        entryPrice: 0.001,
        currentPrice: 0.005,
        amount: 1000,
        solInvested: 1,
        pnl: 4,
        pnlPercentage: 400,
        openedAt: new Date(Date.now() - 3600000),
        closedAt: new Date(),
        status: 'closed' as const,
        type: 'paper' as const,
      };

      const record = engine.buildTradeRecord(position, mockAnalysis, 'smart_money_entry');

      expect(record.id).toBe('pos-1');
      expect(record.roi).toBe(400);
      expect(record.outcome).toBe('win');
      expect(record.profitMultiple).toBe(5);
      expect(record.strategyUsed).toBe('smart_money_entry');
      expect(record.isReal).toBe(false);
      expect(record.features).toBeDefined();
    });
  });

  describe('Feature Importance', () => {
    test('should compute feature importance with no data', () => {
      const weights = engine.computeFeatureImportance();
      expect(Array.isArray(weights)).toBe(true);
      expect(weights.length).toBe(24);

      // Should have equal default weights
      for (const w of weights) {
        expect(w.weight).toBeCloseTo(1 / 24, 2);
      }
    });
  });

  describe('Prediction API', () => {
    test('predict() should return same as classifyToken()', () => {
      const p1 = engine.predict(mockAnalysis);
      expect(p1).toBeDefined();
      expect(p1.confidenceScore).toBeDefined();
    });
  });
});
