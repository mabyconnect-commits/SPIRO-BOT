/**
 * ML Strategy Engine - Machine Learning pipeline for Solana meme token trading
 *
 * Implements:
 * - Pattern classification (high/medium/rug risk)
 * - Strategy ranking by win rate, ROI, Sharpe ratio, drawdown
 * - Feature importance analysis for 5x/10x/100x outcomes
 * - Reinforcement learning loop for strategy evolution
 * - Ensemble voting system (gradient boosting, logistic regression, neural net)
 * - Explainable AI for trade decisions
 * - Continuous learning with periodic retraining
 */

import db from '../database';
import logger from '../utils/logger';
import { AnalysisResult, TradePosition, RunnerPattern } from '../types';
import crypto from 'crypto';

// ============================================================
// TYPES
// ============================================================

export interface MLFeatureVector {
  marketCap: number;
  liquidity: number;
  volume24h: number;
  transactionVelocity: number;
  holderCountGrowth: number;
  buySellRatio: number;
  devWalletInactive: number;
  timeSinceLaunch: number;
  slippage: number;
  priceMomentum: number;
  whaleActivity: number;
  rugSignals: number;
  volumeBreakout: number;
  liquidityScore: number;
  rsi: number;
  volatility: number;
  holderConcentration: number;
  topHolderPercentage: number;
  uniqueHolders: number;
  devWalletLocked: number;
  liquidityLocked: number;
  trendingScore: number;
  smartMoneyPresent: number;
  socialSentiment: number;
}

export interface TradeRecord {
  id: string;
  features: MLFeatureVector;
  entryPrice: number;
  exitPrice: number;
  roi: number;
  maxDrawdown: number;
  timeHeldMinutes: number;
  strategyUsed: string;
  outcome: 'win' | 'loss';
  profitMultiple: number;
  timestamp: number;
  isReal: boolean;
}

export interface StrategyPerformance {
  strategyId: string;
  name: string;
  winRate: number;
  avgROI: number;
  sharpeRatio: number;
  maxDrawdown: number;
  totalTrades: number;
  profitFactor: number;
  isActive: boolean;
  weight: number;
  recentWinRate: number;
}

export interface MLPrediction {
  confidenceScore: number;        // 0-100
  classification: 'high_probability' | 'medium_probability' | 'high_rug_risk';
  strategyRecommendation: string;
  riskScore: number;              // 0-100 (100 = highest risk)
  expectedROIRange: { min: number; max: number };
  allowRealTrading: boolean;
  activeStrategies: string[];
  disabledStrategies: string[];
  explanation: string;
  featureImportance: { feature: string; weight: number; contribution: string }[];
  modelAgreement: number;         // % of models that agree
}

export interface FeatureWeight {
  feature: string;
  weight: number;
  correlationWith5x: number;
  correlationWith10x: number;
  correlationWith100x: number;
  lastUpdated: number;
}

export interface ModelState {
  version: number;
  trainedAt: number;
  trainingSize: number;
  accuracy: number;
  featureWeights: FeatureWeight[];
  strategyWeights: Record<string, number>;
  classificationThresholds: {
    highProbability: number;
    mediumProbability: number;
    rugRisk: number;
  };
  reinforcementState: {
    rewards: Record<string, number>;
    penalties: Record<string, number>;
    positionSizeMultipliers: Record<string, number>;
  };
}

// ============================================================
// GRADIENT BOOSTING MODEL (simplified in-process implementation)
// ============================================================

class GradientBoostingModel {
  private trees: DecisionStump[] = [];
  private learningRate: number = 0.1;
  private nEstimators: number = 50;
  private featureNames: string[] = [];

  train(features: number[][], labels: number[], featureNames: string[]): void {
    this.featureNames = featureNames;
    this.trees = [];
    const n = labels.length;
    if (n === 0) return;

    // Initialize predictions
    const predictions = new Array(n).fill(this.mean(labels));
    let residuals = labels.map((y, i) => y - predictions[i]);

    for (let iter = 0; iter < this.nEstimators; iter++) {
      const stump = this.fitStump(features, residuals);
      this.trees.push(stump);

      // Update predictions
      for (let i = 0; i < n; i++) {
        const pred = this.predictStump(stump, features[i]);
        predictions[i] += this.learningRate * pred;
        residuals[i] = labels[i] - predictions[i];
      }
    }
  }

  predict(features: number[]): number {
    if (this.trees.length === 0) return 0.5;
    let pred = 0;
    for (const tree of this.trees) {
      pred += this.learningRate * this.predictStump(tree, features);
    }
    return this.sigmoid(pred);
  }

  getFeatureImportance(): Record<string, number> {
    const importance: Record<string, number> = {};
    for (const name of this.featureNames) {
      importance[name] = 0;
    }
    for (const tree of this.trees) {
      if (this.featureNames[tree.featureIndex]) {
        importance[this.featureNames[tree.featureIndex]] += tree.improvement;
      }
    }
    // Normalize
    const total = Object.values(importance).reduce((a, b) => a + Math.abs(b), 0) || 1;
    for (const key of Object.keys(importance)) {
      importance[key] = importance[key] / total;
    }
    return importance;
  }

  private fitStump(features: number[][], residuals: number[]): DecisionStump {
    let bestFeature = 0;
    let bestThreshold = 0;
    let bestImprovement = -Infinity;
    let bestLeftMean = 0;
    let bestRightMean = 0;

    const nFeatures = features[0]?.length || 0;
    const totalVariance = this.variance(residuals);

    for (let f = 0; f < nFeatures; f++) {
      const values = features.map(row => row[f]);
      const sortedUnique = [...new Set(values)].sort((a, b) => a - b);

      for (let t = 0; t < Math.min(sortedUnique.length - 1, 10); t++) {
        const threshold = (sortedUnique[t] + sortedUnique[Math.min(t + 1, sortedUnique.length - 1)]) / 2;
        const leftResiduals: number[] = [];
        const rightResiduals: number[] = [];

        for (let i = 0; i < features.length; i++) {
          if (features[i][f] <= threshold) {
            leftResiduals.push(residuals[i]);
          } else {
            rightResiduals.push(residuals[i]);
          }
        }

        if (leftResiduals.length === 0 || rightResiduals.length === 0) continue;

        const leftVar = this.variance(leftResiduals) * leftResiduals.length;
        const rightVar = this.variance(rightResiduals) * rightResiduals.length;
        const improvement = totalVariance * residuals.length - leftVar - rightVar;

        if (improvement > bestImprovement) {
          bestImprovement = improvement;
          bestFeature = f;
          bestThreshold = threshold;
          bestLeftMean = this.mean(leftResiduals);
          bestRightMean = this.mean(rightResiduals);
        }
      }
    }

    return {
      featureIndex: bestFeature,
      threshold: bestThreshold,
      leftValue: bestLeftMean,
      rightValue: bestRightMean,
      improvement: Math.max(0, bestImprovement),
    };
  }

  private predictStump(stump: DecisionStump, features: number[]): number {
    return features[stump.featureIndex] <= stump.threshold ? stump.leftValue : stump.rightValue;
  }

  private mean(arr: number[]): number {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  private variance(arr: number[]): number {
    if (arr.length === 0) return 0;
    const m = this.mean(arr);
    return arr.reduce((sum, x) => sum + (x - m) ** 2, 0) / arr.length;
  }

  private sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-Math.max(-10, Math.min(10, x))));
  }
}

interface DecisionStump {
  featureIndex: number;
  threshold: number;
  leftValue: number;
  rightValue: number;
  improvement: number;
}

// ============================================================
// LOGISTIC REGRESSION MODEL
// ============================================================

class LogisticRegressionModel {
  private weights: number[] = [];
  private bias: number = 0;
  private featureNames: string[] = [];
  private learningRate: number = 0.01;
  private iterations: number = 200;

  train(features: number[][], labels: number[], featureNames: string[]): void {
    this.featureNames = featureNames;
    const nFeatures = features[0]?.length || 0;
    if (features.length === 0 || nFeatures === 0) return;

    this.weights = new Array(nFeatures).fill(0);
    this.bias = 0;

    // Normalize features
    const means = new Array(nFeatures).fill(0);
    const stds = new Array(nFeatures).fill(1);
    for (let f = 0; f < nFeatures; f++) {
      const col = features.map(row => row[f]);
      means[f] = col.reduce((a, b) => a + b, 0) / col.length;
      const variance = col.reduce((sum, x) => sum + (x - means[f]) ** 2, 0) / col.length;
      stds[f] = Math.sqrt(variance) || 1;
    }

    const normalized = features.map(row =>
      row.map((val, f) => (val - means[f]) / stds[f])
    );

    // Gradient descent
    for (let iter = 0; iter < this.iterations; iter++) {
      for (let i = 0; i < normalized.length; i++) {
        const pred = this.sigmoid(this.dotProduct(normalized[i]) + this.bias);
        const error = pred - labels[i];

        for (let f = 0; f < nFeatures; f++) {
          this.weights[f] -= this.learningRate * error * normalized[i][f];
        }
        this.bias -= this.learningRate * error;
      }
    }
  }

  predict(features: number[]): number {
    if (this.weights.length === 0) return 0.5;
    return this.sigmoid(this.dotProduct(features) + this.bias);
  }

  getCoefficients(): Record<string, number> {
    const coeffs: Record<string, number> = {};
    for (let i = 0; i < this.featureNames.length; i++) {
      coeffs[this.featureNames[i]] = this.weights[i] || 0;
    }
    return coeffs;
  }

  private dotProduct(features: number[]): number {
    let sum = 0;
    for (let i = 0; i < Math.min(features.length, this.weights.length); i++) {
      sum += features[i] * this.weights[i];
    }
    return sum;
  }

  private sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-Math.max(-10, Math.min(10, x))));
  }
}

// ============================================================
// SIMPLE NEURAL NETWORK (1 hidden layer)
// ============================================================

class NeuralNetworkModel {
  private weightsIH: number[][] = [];
  private weightsHO: number[] = [];
  private biasH: number[] = [];
  private biasO: number = 0;
  private hiddenSize: number = 16;
  private learningRate: number = 0.005;
  private iterations: number = 100;
  private featureNames: string[] = [];

  train(features: number[][], labels: number[], featureNames: string[]): void {
    this.featureNames = featureNames;
    const inputSize = features[0]?.length || 0;
    if (features.length === 0 || inputSize === 0) return;

    // Xavier initialization
    const scale = Math.sqrt(2.0 / inputSize);
    this.weightsIH = Array.from({ length: this.hiddenSize }, () =>
      Array.from({ length: inputSize }, () => (Math.random() - 0.5) * scale)
    );
    this.weightsHO = Array.from({ length: this.hiddenSize }, () => (Math.random() - 0.5) * scale);
    this.biasH = new Array(this.hiddenSize).fill(0);
    this.biasO = 0;

    // Training loop
    for (let iter = 0; iter < this.iterations; iter++) {
      for (let i = 0; i < features.length; i++) {
        // Forward pass
        const hidden = this.biasH.map((b, h) => {
          let sum = b;
          for (let f = 0; f < inputSize; f++) {
            sum += this.weightsIH[h][f] * features[i][f];
          }
          return this.relu(sum);
        });

        let output = this.biasO;
        for (let h = 0; h < this.hiddenSize; h++) {
          output += this.weightsHO[h] * hidden[h];
        }
        const pred = this.sigmoid(output);

        // Backward pass
        const outputError = pred - labels[i];
        const outputGrad = outputError;

        for (let h = 0; h < this.hiddenSize; h++) {
          const hiddenGrad = outputGrad * this.weightsHO[h] * this.reluDerivative(hidden[h]);
          this.weightsHO[h] -= this.learningRate * outputGrad * hidden[h];
          for (let f = 0; f < inputSize; f++) {
            this.weightsIH[h][f] -= this.learningRate * hiddenGrad * features[i][f];
          }
          this.biasH[h] -= this.learningRate * hiddenGrad;
        }
        this.biasO -= this.learningRate * outputGrad;
      }
    }
  }

  predict(features: number[]): number {
    if (this.weightsIH.length === 0) return 0.5;
    const inputSize = features.length;

    const hidden = this.biasH.map((b, h) => {
      let sum = b;
      for (let f = 0; f < inputSize; f++) {
        sum += (this.weightsIH[h]?.[f] || 0) * features[f];
      }
      return this.relu(sum);
    });

    let output = this.biasO;
    for (let h = 0; h < this.hiddenSize; h++) {
      output += this.weightsHO[h] * hidden[h];
    }
    return this.sigmoid(output);
  }

  private relu(x: number): number { return Math.max(0, x); }
  private reluDerivative(x: number): number { return x > 0 ? 1 : 0; }
  private sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-Math.max(-10, Math.min(10, x))));
  }
}

// ============================================================
// ML STRATEGY ENGINE (main class)
// ============================================================

export class MLStrategyEngine {
  private gbModel: GradientBoostingModel;
  private lrModel: LogisticRegressionModel;
  private nnModel: NeuralNetworkModel;
  private modelState: ModelState;
  private tradeHistory: TradeRecord[] = [];
  private strategyPerformance: Map<string, StrategyPerformance> = new Map();
  private retrainIntervalMs: number = 3600000; // 1 hour
  private lastRetrainTime: number = 0;
  private minTradesForRealTrading: number = 50;
  private minWinRateForRealTrading: number = 0.55;
  private confidenceThreshold: number = 60;

  private static readonly FEATURE_NAMES: string[] = [
    'marketCap', 'liquidity', 'volume24h', 'transactionVelocity',
    'holderCountGrowth', 'buySellRatio', 'devWalletInactive', 'timeSinceLaunch',
    'slippage', 'priceMomentum', 'whaleActivity', 'rugSignals',
    'volumeBreakout', 'liquidityScore', 'rsi', 'volatility',
    'holderConcentration', 'topHolderPercentage', 'uniqueHolders',
    'devWalletLocked', 'liquidityLocked', 'trendingScore',
    'smartMoneyPresent', 'socialSentiment',
  ];

  constructor() {
    this.gbModel = new GradientBoostingModel();
    this.lrModel = new LogisticRegressionModel();
    this.nnModel = new NeuralNetworkModel();
    this.modelState = this.loadModelState();
    this.loadTradeHistory();
    this.initializeStrategies();
    logger.info(`ML Strategy Engine initialized (v${this.modelState.version}, ${this.tradeHistory.length} historical trades)`);
  }

  // ============================================================
  // FEATURE EXTRACTION
  // ============================================================

  extractFeatures(analysis: AnalysisResult): MLFeatureVector {
    const token = analysis.token;
    const tech = analysis.technical;
    const fund = analysis.fundamental;
    const social = analysis.social;

    const timeSinceLaunch = token.createdAt
      ? (Date.now() - new Date(token.createdAt).getTime()) / 3600000
      : 24;

    return {
      marketCap: this.normalize(token.marketCap, 0, 10_000_000),
      liquidity: this.normalize(token.liquidity, 0, 5_000_000),
      volume24h: this.normalize(token.volume24h, 0, 10_000_000),
      transactionVelocity: this.normalize(token.volume24h / Math.max(token.liquidity, 1), 0, 10),
      holderCountGrowth: this.normalize(fund.uniqueHolders, 0, 10000),
      buySellRatio: tech.priceAction === 'bullish' ? 0.8 : tech.priceAction === 'bearish' ? 0.2 : 0.5,
      devWalletInactive: fund.devWalletLocked ? 1 : 0,
      timeSinceLaunch: this.normalize(timeSinceLaunch, 0, 168),
      slippage: this.normalize(tech.volatility * 100, 0, 50),
      priceMomentum: this.normalize(token.priceChange24h, -100, 1000),
      whaleActivity: fund.topHolderPercentage > 20 ? 0.8 : 0.3,
      rugSignals: this.computeRugSignals(fund, tech),
      volumeBreakout: tech.volumeBreakout ? 1 : 0,
      liquidityScore: this.normalize(tech.liquidityScore, 0, 1),
      rsi: this.normalize(tech.rsi, 0, 100),
      volatility: this.normalize(tech.volatility, 0, 1),
      holderConcentration: this.normalize(fund.holderConcentration, 0, 1),
      topHolderPercentage: this.normalize(fund.topHolderPercentage, 0, 100),
      uniqueHolders: this.normalize(fund.uniqueHolders, 0, 10000),
      devWalletLocked: fund.devWalletLocked ? 1 : 0,
      liquidityLocked: fund.liquidityLocked ? 1 : 0,
      trendingScore: this.normalize(social.trendingScore, 0, 1),
      smartMoneyPresent: analysis.walletSignals?.some(w => w.isSmartMoney) ? 1 : 0,
      socialSentiment: social.sentiment === 'positive' ? 1 : social.sentiment === 'negative' ? 0 : 0.5,
    };
  }

  featureVectorToArray(features: MLFeatureVector): number[] {
    return MLStrategyEngine.FEATURE_NAMES.map(name => (features as any)[name] ?? 0);
  }

  private computeRugSignals(fund: any, tech: any): number {
    let score = 0;
    if (!fund.devWalletLocked) score += 0.3;
    if (!fund.liquidityLocked) score += 0.3;
    if (fund.topHolderPercentage > 50) score += 0.2;
    if (fund.holderConcentration > 0.8) score += 0.2;
    return Math.min(1, score);
  }

  private normalize(value: number, min: number, max: number): number {
    if (max === min) return 0.5;
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
  }

  // ============================================================
  // PATTERN CLASSIFICATION
  // ============================================================

  classifyToken(analysis: AnalysisResult): MLPrediction {
    const features = this.extractFeatures(analysis);
    const featureArray = this.featureVectorToArray(features);

    // Get predictions from all models
    const gbPred = this.gbModel.predict(featureArray);
    const lrPred = this.lrModel.predict(featureArray);
    const nnPred = this.nnModel.predict(featureArray);

    // Ensemble voting (weighted)
    const ensembleWeights = { gb: 0.45, lr: 0.25, nn: 0.30 };
    const ensemblePred = gbPred * ensembleWeights.gb +
                         lrPred * ensembleWeights.lr +
                         nnPred * ensembleWeights.nn;

    // Classification
    const thresholds = this.modelState.classificationThresholds;
    let classification: MLPrediction['classification'];
    if (features.rugSignals > 0.6) {
      classification = 'high_rug_risk';
    } else if (ensemblePred >= thresholds.highProbability) {
      classification = 'high_probability';
    } else if (ensemblePred >= thresholds.mediumProbability) {
      classification = 'medium_probability';
    } else {
      classification = 'high_rug_risk';
    }

    // Risk score (0-100, 100 = riskiest)
    const riskScore = Math.round(
      (features.rugSignals * 40) +
      ((1 - features.liquidityScore) * 20) +
      (features.volatility * 15) +
      ((1 - features.devWalletLocked) * 15) +
      ((1 - features.liquidityLocked) * 10)
    );

    // Confidence score (0-100)
    const confidenceScore = Math.round(ensemblePred * 100);

    // Model agreement
    const predictions = [gbPred, lrPred, nnPred];
    const agreedOnWin = predictions.filter(p => p >= 0.5).length;
    const modelAgreement = Math.round((Math.max(agreedOnWin, 3 - agreedOnWin) / 3) * 100);

    // Strategy recommendation
    const strategyRec = this.recommendStrategy(features, confidenceScore);

    // Expected ROI range
    const expectedROI = this.estimateROIRange(features, ensemblePred);

    // Whether real trading is allowed
    const allowRealTrading = this.shouldAllowRealTrading(confidenceScore, riskScore);

    // Active/disabled strategies
    const { active, disabled } = this.getStrategyStatus();

    // Feature importance explanation
    const featureImportance = this.explainPrediction(features, analysis);

    // Human-readable explanation
    const explanation = this.generateExplanation(
      analysis, features, confidenceScore, classification, featureImportance
    );

    return {
      confidenceScore,
      classification,
      strategyRecommendation: strategyRec,
      riskScore,
      expectedROIRange: expectedROI,
      allowRealTrading,
      activeStrategies: active,
      disabledStrategies: disabled,
      explanation,
      featureImportance,
      modelAgreement,
    };
  }

  // ============================================================
  // STRATEGY RANKING
  // ============================================================

  rankStrategies(): StrategyPerformance[] {
    const strategies = Array.from(this.strategyPerformance.values());

    // Calculate metrics for each
    for (const strat of strategies) {
      const trades = this.tradeHistory.filter(t => t.strategyUsed === strat.strategyId);
      if (trades.length === 0) continue;

      const wins = trades.filter(t => t.outcome === 'win').length;
      strat.winRate = wins / trades.length;
      strat.avgROI = trades.reduce((sum, t) => sum + t.roi, 0) / trades.length;
      strat.totalTrades = trades.length;

      // Sharpe ratio (simplified: mean return / std of returns)
      const returns = trades.map(t => t.roi);
      const meanReturn = strat.avgROI;
      const stdReturn = Math.sqrt(
        returns.reduce((sum, r) => sum + (r - meanReturn) ** 2, 0) / returns.length
      ) || 1;
      strat.sharpeRatio = meanReturn / stdReturn;

      // Max drawdown
      let peak = 0;
      let maxDD = 0;
      let cumReturn = 0;
      for (const trade of trades) {
        cumReturn += trade.roi;
        peak = Math.max(peak, cumReturn);
        maxDD = Math.min(maxDD, cumReturn - peak);
      }
      strat.maxDrawdown = Math.abs(maxDD);

      // Profit factor
      const grossProfit = trades.filter(t => t.roi > 0).reduce((s, t) => s + t.roi, 0);
      const grossLoss = Math.abs(trades.filter(t => t.roi < 0).reduce((s, t) => s + t.roi, 0)) || 1;
      strat.profitFactor = grossProfit / grossLoss;

      // Recent performance (last 20 trades)
      const recent = trades.slice(-20);
      const recentWins = recent.filter(t => t.outcome === 'win').length;
      strat.recentWinRate = recent.length > 0 ? recentWins / recent.length : 0;

      // Auto-disable underperforming strategies
      if (strat.totalTrades >= 20 && strat.winRate < 0.35 && strat.recentWinRate < 0.3) {
        strat.isActive = false;
        logger.warn(`Strategy "${strat.name}" auto-disabled: ${(strat.winRate * 100).toFixed(1)}% win rate`);
      }

      // Re-enable if recent performance improves
      if (!strat.isActive && strat.recentWinRate > 0.5 && recent.length >= 10) {
        strat.isActive = true;
        logger.info(`Strategy "${strat.name}" re-enabled: recent win rate ${(strat.recentWinRate * 100).toFixed(1)}%`);
      }
    }

    // Sort by composite score
    return strategies.sort((a, b) => {
      const scoreA = (a.winRate * 0.3) + (a.sharpeRatio * 0.3) + (a.profitFactor * 0.2) - (a.maxDrawdown * 0.2);
      const scoreB = (b.winRate * 0.3) + (b.sharpeRatio * 0.3) + (b.profitFactor * 0.2) - (b.maxDrawdown * 0.2);
      return scoreB - scoreA;
    });
  }

  // ============================================================
  // FEATURE IMPORTANCE
  // ============================================================

  computeFeatureImportance(): FeatureWeight[] {
    const trades5x = this.tradeHistory.filter(t => t.profitMultiple >= 5);
    const trades10x = this.tradeHistory.filter(t => t.profitMultiple >= 10);
    const trades100x = this.tradeHistory.filter(t => t.profitMultiple >= 100);
    const allTrades = this.tradeHistory;

    if (allTrades.length < 10) {
      return MLStrategyEngine.FEATURE_NAMES.map(name => ({
        feature: name,
        weight: 1 / MLStrategyEngine.FEATURE_NAMES.length,
        correlationWith5x: 0,
        correlationWith10x: 0,
        correlationWith100x: 0,
        lastUpdated: Date.now(),
      }));
    }

    // GB model feature importance
    const gbImportance = this.gbModel.getFeatureImportance();

    // LR coefficients
    const lrCoeffs = this.lrModel.getCoefficients();

    // Compute correlations with multiplier outcomes
    const featureWeights: FeatureWeight[] = MLStrategyEngine.FEATURE_NAMES.map(name => {
      const allValues = allTrades.map(t => (t.features as any)[name] ?? 0);
      const corr5x = this.correlationWithOutcome(allValues, allTrades, 5);
      const corr10x = this.correlationWithOutcome(allValues, allTrades, 10);
      const corr100x = this.correlationWithOutcome(allValues, allTrades, 100);

      // Blend GB importance + LR coefficient + correlation
      const weight = (Math.abs(gbImportance[name] || 0) * 0.4) +
                     (Math.abs(lrCoeffs[name] || 0) * 0.3) +
                     (Math.abs(corr10x) * 0.3);

      return {
        feature: name,
        weight,
        correlationWith5x: corr5x,
        correlationWith10x: corr10x,
        correlationWith100x: corr100x,
        lastUpdated: Date.now(),
      };
    });

    // Normalize weights
    const totalWeight = featureWeights.reduce((s, fw) => s + fw.weight, 0) || 1;
    featureWeights.forEach(fw => fw.weight /= totalWeight);

    // Persist
    this.modelState.featureWeights = featureWeights;
    this.saveModelState();

    return featureWeights;
  }

  private correlationWithOutcome(featureValues: number[], trades: TradeRecord[], multiplier: number): number {
    if (trades.length < 5) return 0;
    const outcomes = trades.map(t => t.profitMultiple >= multiplier ? 1 : 0);
    return this.pearsonCorrelation(featureValues, outcomes);
  }

  private pearsonCorrelation(x: number[], y: number[]): number {
    const n = Math.min(x.length, y.length);
    if (n < 3) return 0;
    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;
    let num = 0, denX = 0, denY = 0;
    for (let i = 0; i < n; i++) {
      const dx = x[i] - meanX;
      const dy = y[i] - meanY;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    }
    const den = Math.sqrt(denX * denY);
    return den === 0 ? 0 : num / den;
  }

  // ============================================================
  // REINFORCEMENT LEARNING LOOP
  // ============================================================

  recordTradeOutcome(trade: TradeRecord): void {
    this.tradeHistory.push(trade);

    const rl = this.modelState.reinforcementState;
    const stratId = trade.strategyUsed;

    // Initialize if new strategy
    if (!rl.rewards[stratId]) rl.rewards[stratId] = 0;
    if (!rl.penalties[stratId]) rl.penalties[stratId] = 0;
    if (!rl.positionSizeMultipliers[stratId]) rl.positionSizeMultipliers[stratId] = 1.0;

    if (trade.outcome === 'win') {
      // Reward proportional to profit multiple
      const reward = Math.min(10, trade.profitMultiple);
      rl.rewards[stratId] += reward;

      // Increase position size for winning strategies (max 2x)
      rl.positionSizeMultipliers[stratId] = Math.min(2.0,
        rl.positionSizeMultipliers[stratId] * (1 + 0.05 * trade.profitMultiple)
      );
    } else {
      // Penalty proportional to loss
      const penalty = Math.abs(trade.roi) / 100;
      rl.penalties[stratId] += penalty;

      // Decrease position size for losing strategies (min 0.25x)
      rl.positionSizeMultipliers[stratId] = Math.max(0.25,
        rl.positionSizeMultipliers[stratId] * 0.9
      );
    }

    // Update strategy weight based on reward-penalty balance
    const netScore = rl.rewards[stratId] - rl.penalties[stratId];
    this.modelState.strategyWeights[stratId] = Math.max(0.1, Math.min(5.0,
      1.0 + (netScore / Math.max(1, this.tradeHistory.filter(t => t.strategyUsed === stratId).length))
    ));

    // Persist
    this.saveModelState();
    this.persistTradeRecord(trade);

    // Check if retrain needed
    if (Date.now() - this.lastRetrainTime > this.retrainIntervalMs) {
      this.retrain();
    }

    logger.info(
      `RL update: strategy="${stratId}" outcome=${trade.outcome} ` +
      `roi=${trade.roi.toFixed(2)}% posSize=${rl.positionSizeMultipliers[stratId].toFixed(2)}x`
    );
  }

  getPositionSizeMultiplier(strategyId: string): number {
    return this.modelState.reinforcementState.positionSizeMultipliers[strategyId] || 1.0;
  }

  // ============================================================
  // TRAINING LOOP
  // ============================================================

  retrain(): void {
    if (this.tradeHistory.length < 10) {
      logger.info('Not enough trades for retraining (need 10+)');
      return;
    }

    logger.info(`Retraining ML models with ${this.tradeHistory.length} trades...`);

    const features = this.tradeHistory.map(t => this.featureVectorToArray(t.features));
    const labels = this.tradeHistory.map(t => t.outcome === 'win' ? 1 : 0);

    // Train all three models
    this.gbModel.train(features, labels, MLStrategyEngine.FEATURE_NAMES);
    this.lrModel.train(features, labels, MLStrategyEngine.FEATURE_NAMES);
    this.nnModel.train(features, labels, MLStrategyEngine.FEATURE_NAMES);

    // Evaluate accuracy on training data
    let correct = 0;
    for (let i = 0; i < features.length; i++) {
      const pred = this.gbModel.predict(features[i]);
      const predicted = pred >= 0.5 ? 1 : 0;
      if (predicted === labels[i]) correct++;
    }
    const accuracy = correct / features.length;

    // Update feature importance
    this.computeFeatureImportance();

    // Update model state
    this.modelState.version++;
    this.modelState.trainedAt = Date.now();
    this.modelState.trainingSize = this.tradeHistory.length;
    this.modelState.accuracy = accuracy;
    this.lastRetrainTime = Date.now();

    // Rank strategies
    this.rankStrategies();

    this.saveModelState();
    logger.info(`Retrained: v${this.modelState.version} accuracy=${(accuracy * 100).toFixed(1)}% features=${MLStrategyEngine.FEATURE_NAMES.length}`);
  }

  // ============================================================
  // PREDICTION API
  // ============================================================

  predict(analysis: AnalysisResult): MLPrediction {
    return this.classifyToken(analysis);
  }

  // ============================================================
  // EXPLAINABILITY
  // ============================================================

  private explainPrediction(
    features: MLFeatureVector,
    analysis: AnalysisResult
  ): { feature: string; weight: number; contribution: string }[] {
    const featureWeights = this.modelState.featureWeights;
    if (featureWeights.length === 0) {
      return this.getDefaultFeatureExplanation(features);
    }

    const explanations: { feature: string; weight: number; contribution: string }[] = [];

    for (const fw of featureWeights) {
      const value = (features as any)[fw.feature] ?? 0;
      let contribution: string;

      if (fw.weight > 0.08 && value > 0.7) {
        contribution = `Strong positive signal (${(value * 100).toFixed(0)}%)`;
      } else if (fw.weight > 0.08 && value < 0.3) {
        contribution = `Weak/negative signal (${(value * 100).toFixed(0)}%)`;
      } else if (fw.weight > 0.05) {
        contribution = `Moderate signal (${(value * 100).toFixed(0)}%)`;
      } else {
        continue; // Skip low importance features
      }

      explanations.push({ feature: fw.feature, weight: fw.weight, contribution });
    }

    return explanations.sort((a, b) => b.weight - a.weight).slice(0, 8);
  }

  private getDefaultFeatureExplanation(features: MLFeatureVector): { feature: string; weight: number; contribution: string }[] {
    const explanations: { feature: string; weight: number; contribution: string }[] = [];
    const featureEntries = Object.entries(features) as [string, number][];

    for (const [name, value] of featureEntries) {
      if (value > 0.7) {
        explanations.push({ feature: name, weight: value, contribution: 'Strong positive signal' });
      } else if (value < 0.2 && name === 'rugSignals') {
        explanations.push({ feature: name, weight: 1 - value, contribution: 'Low rug risk (positive)' });
      }
    }
    return explanations.sort((a, b) => b.weight - a.weight).slice(0, 6);
  }

  generateExplanation(
    analysis: AnalysisResult,
    features: MLFeatureVector,
    confidence: number,
    classification: string,
    importantFeatures: { feature: string; weight: number; contribution: string }[]
  ): string {
    const token = analysis.token;
    const topFeatures = importantFeatures.slice(0, 4);

    // Find historical similarity
    const similar = this.findSimilarWinners(features);
    const similarityPct = similar.length > 0
      ? Math.round(similar.reduce((s, t) => s + t.similarity, 0) / similar.length * 100)
      : 0;

    let explanation = '';

    if (classification === 'high_probability') {
      explanation += `This token matches ${similarityPct}% of previous winning patterns. `;
    } else if (classification === 'high_rug_risk') {
      explanation += `WARNING: This token shows ${Math.round(features.rugSignals * 100)}% rug risk signals. `;
    } else {
      explanation += `This token shows mixed signals (${confidence}% confidence). `;
    }

    // Feature reasons
    const reasons: string[] = [];
    for (const feat of topFeatures) {
      const readable = this.featureToReadable(feat.feature, (features as any)[feat.feature]);
      if (readable) reasons.push(readable);
    }

    if (reasons.length > 0) {
      explanation += `Key factors: ${reasons.join(' + ')}. `;
    }

    // Historical context
    if (similar.length > 0) {
      const avgMultiple = similar.reduce((s, t) => s + t.trade.profitMultiple, 0) / similar.length;
      explanation += `Similar tokens averaged ${avgMultiple.toFixed(1)}x returns.`;
    }

    return explanation;
  }

  private featureToReadable(feature: string, value: number): string | null {
    const map: Record<string, (v: number) => string | null> = {
      volumeBreakout: (v) => v > 0.5 ? 'volume spike detected' : null,
      holderCountGrowth: (v) => v > 0.5 ? 'strong holder growth' : null,
      devWalletInactive: (v) => v > 0.5 ? 'dev wallet inactive (good)' : 'dev wallet active (caution)',
      priceMomentum: (v) => v > 0.6 ? 'strong price momentum' : v < 0.3 ? 'weak momentum' : null,
      smartMoneyPresent: (v) => v > 0.5 ? 'smart money detected' : null,
      liquidityLocked: (v) => v > 0.5 ? 'liquidity locked' : 'liquidity NOT locked',
      rugSignals: (v) => v > 0.5 ? 'HIGH rug signals' : v < 0.2 ? 'low rug risk' : null,
      socialSentiment: (v) => v > 0.7 ? 'positive social sentiment' : null,
      whaleActivity: (v) => v > 0.6 ? 'whale accumulation' : null,
      buySellRatio: (v) => v > 0.6 ? 'strong buy pressure' : v < 0.3 ? 'sell pressure' : null,
    };

    const fn = map[feature];
    return fn ? fn(value) : null;
  }

  private findSimilarWinners(features: MLFeatureVector): { trade: TradeRecord; similarity: number }[] {
    const winners = this.tradeHistory.filter(t => t.outcome === 'win' && t.profitMultiple >= 2);
    if (winners.length === 0) return [];

    const currentArray = this.featureVectorToArray(features);

    return winners
      .map(trade => {
        const tradeArray = this.featureVectorToArray(trade.features);
        const similarity = this.cosineSimilarity(currentArray, tradeArray);
        return { trade, similarity };
      })
      .filter(item => item.similarity > 0.6)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 10);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
  }

  // ============================================================
  // STRATEGY MANAGEMENT
  // ============================================================

  private recommendStrategy(features: MLFeatureVector, confidence: number): string {
    if (features.rugSignals > 0.5) return 'avoid';
    if (confidence >= 80 && features.smartMoneyPresent > 0.5) return 'aggressive';
    if (confidence >= 70) return 'balanced';
    if (confidence >= 55) return 'moderate';
    return 'conservative';
  }

  private shouldAllowRealTrading(confidence: number, riskScore: number): boolean {
    if (this.tradeHistory.length < this.minTradesForRealTrading) return false;

    const winRate = this.tradeHistory.filter(t => t.outcome === 'win').length / this.tradeHistory.length;
    if (winRate < this.minWinRateForRealTrading) return false;

    if (confidence < this.confidenceThreshold) return false;
    if (riskScore > 70) return false;
    if (this.modelState.accuracy < 0.55) return false;

    return true;
  }

  private estimateROIRange(features: MLFeatureVector, ensemblePred: number): { min: number; max: number } {
    // Based on similar historical trades
    const similar = this.findSimilarWinners(features);
    if (similar.length >= 3) {
      const rois = similar.map(s => s.trade.roi);
      rois.sort((a, b) => a - b);
      return {
        min: Math.round(rois[Math.floor(rois.length * 0.25)] || -30),
        max: Math.round(rois[Math.floor(rois.length * 0.75)] || 200),
      };
    }

    // Default estimate based on confidence
    return {
      min: Math.round(-30 + ensemblePred * 20),
      max: Math.round(50 + ensemblePred * 500),
    };
  }

  private getStrategyStatus(): { active: string[]; disabled: string[] } {
    const active: string[] = [];
    const disabled: string[] = [];
    for (const [id, perf] of this.strategyPerformance) {
      if (perf.isActive) active.push(perf.name);
      else disabled.push(perf.name);
    }
    return { active, disabled };
  }

  // ============================================================
  // STATS & REPORTS
  // ============================================================

  getMLStats(): string {
    const totalTrades = this.tradeHistory.length;
    const wins = this.tradeHistory.filter(t => t.outcome === 'win').length;
    const winRate = totalTrades > 0 ? (wins / totalTrades * 100).toFixed(1) : '0.0';
    const avgROI = totalTrades > 0
      ? (this.tradeHistory.reduce((s, t) => s + t.roi, 0) / totalTrades).toFixed(2)
      : '0.00';

    const real = this.tradeHistory.filter(t => t.isReal);
    const sim = this.tradeHistory.filter(t => !t.isReal);

    let stats = `🧠 *ML Strategy Engine Stats*\n\n`;
    stats += `📊 *Model*: v${this.modelState.version}\n`;
    stats += `🎯 *Accuracy*: ${(this.modelState.accuracy * 100).toFixed(1)}%\n`;
    stats += `📈 *Training Size*: ${this.modelState.trainingSize} trades\n`;
    stats += `⏰ *Last Trained*: ${this.modelState.trainedAt ? new Date(this.modelState.trainedAt).toLocaleString() : 'Never'}\n\n`;

    stats += `📉 *Trade Performance*\n`;
    stats += `• Total: ${totalTrades} trades\n`;
    stats += `• Win Rate: ${winRate}%\n`;
    stats += `• Avg ROI: ${avgROI}%\n`;
    stats += `• Sim Trades: ${sim.length}\n`;
    stats += `• Real Trades: ${real.length}\n\n`;

    // Top 5x+ winners
    const big = this.tradeHistory.filter(t => t.profitMultiple >= 5);
    stats += `🏆 *Big Winners*: ${big.length} trades at 5x+\n`;

    const topStrats = this.rankStrategies().slice(0, 3);
    if (topStrats.length > 0) {
      stats += `\n🥇 *Top Strategies*\n`;
      topStrats.forEach((s, i) => {
        const medal = ['🥇', '🥈', '🥉'][i];
        stats += `${medal} ${s.name}: ${(s.winRate * 100).toFixed(0)}% WR, ${s.avgROI.toFixed(1)}% ROI\n`;
      });
    }

    return stats;
  }

  getTopStrategies(): StrategyPerformance[] {
    return this.rankStrategies().filter(s => s.isActive);
  }

  getPatternReport(): string {
    const featureWeights = this.modelState.featureWeights.length > 0
      ? this.modelState.featureWeights
      : this.computeFeatureImportance();

    let report = `📊 *Pattern & Feature Report*\n\n`;
    report += `🔬 *Top Features for Winners*\n`;

    const sorted = [...featureWeights].sort((a, b) => b.weight - a.weight);
    sorted.slice(0, 10).forEach((fw, i) => {
      report += `${i + 1}. *${fw.feature}*: weight ${(fw.weight * 100).toFixed(1)}%\n`;
      if (fw.correlationWith10x !== 0) {
        report += `   ↳ 10x correlation: ${(fw.correlationWith10x * 100).toFixed(1)}%\n`;
      }
    });

    report += `\n📈 *Active Strategies*\n`;
    const strategies = this.rankStrategies();
    strategies.filter(s => s.isActive).forEach(s => {
      report += `✅ ${s.name}: ${(s.winRate * 100).toFixed(0)}% WR, Sharpe ${s.sharpeRatio.toFixed(2)}\n`;
    });

    const disabled = strategies.filter(s => !s.isActive);
    if (disabled.length > 0) {
      report += `\n❌ *Disabled Strategies*\n`;
      disabled.forEach(s => {
        report += `🚫 ${s.name}: ${(s.winRate * 100).toFixed(0)}% WR (auto-disabled)\n`;
      });
    }

    return report;
  }

  explainTrade(analysis: AnalysisResult): string {
    const prediction = this.classifyToken(analysis);
    let explanation = `🧠 *Why This Trade?*\n\n`;
    explanation += `*Token*: ${analysis.token.symbol}\n`;
    explanation += `*Confidence*: ${prediction.confidenceScore}%\n`;
    explanation += `*Classification*: ${prediction.classification.replace(/_/g, ' ')}\n`;
    explanation += `*Risk Score*: ${prediction.riskScore}/100\n`;
    explanation += `*Strategy*: ${prediction.strategyRecommendation}\n`;
    explanation += `*Expected ROI*: ${prediction.expectedROIRange.min}% to ${prediction.expectedROIRange.max}%\n`;
    explanation += `*Real Trading*: ${prediction.allowRealTrading ? '✅ Allowed' : '❌ Simulation Only'}\n`;
    explanation += `*Model Agreement*: ${prediction.modelAgreement}%\n\n`;

    explanation += `📋 *Key Factors*\n`;
    prediction.featureImportance.forEach(fi => {
      explanation += `• *${fi.feature}*: ${fi.contribution}\n`;
    });

    explanation += `\n💬 *AI Reasoning*\n`;
    explanation += prediction.explanation;

    return explanation;
  }

  // ============================================================
  // PERSISTENCE
  // ============================================================

  private loadModelState(): ModelState {
    try {
      const row = this.queryDB(
        `SELECT data FROM ml_model_state WHERE id = 'current' LIMIT 1`
      );
      if (row) {
        return JSON.parse(row.data);
      }
    } catch {
      // Table may not exist yet
    }
    return this.getDefaultModelState();
  }

  private saveModelState(): void {
    try {
      this.execDB(`
        CREATE TABLE IF NOT EXISTS ml_model_state (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.execDB(
        `INSERT OR REPLACE INTO ml_model_state (id, data, updated_at) VALUES ('current', ?, CURRENT_TIMESTAMP)`,
        [JSON.stringify(this.modelState)]
      );
    } catch (error) {
      logger.error('Error saving model state:', error);
    }
  }

  private loadTradeHistory(): void {
    try {
      const rows = this.queryAllDB(
        `SELECT data FROM ml_trade_history ORDER BY rowid`
      );
      if (rows) {
        this.tradeHistory = rows.map((r: any) => JSON.parse(r.data));
      }
    } catch {
      // Table may not exist
      this.tradeHistory = [];
    }
  }

  private persistTradeRecord(trade: TradeRecord): void {
    try {
      this.execDB(`
        CREATE TABLE IF NOT EXISTS ml_trade_history (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.execDB(
        `INSERT OR REPLACE INTO ml_trade_history (id, data) VALUES (?, ?)`,
        [trade.id, JSON.stringify(trade)]
      );
    } catch (error) {
      logger.error('Error persisting trade record:', error);
    }
  }

  private initializeStrategies(): void {
    const defaultStrategies = [
      { id: 'smart_money_entry', name: 'Smart Money Entry' },
      { id: 'volume_breakout', name: 'Volume Breakout' },
      { id: 'fresh_launch', name: 'Fresh Launch' },
      { id: 'whale_accumulation', name: 'Whale Accumulation' },
      { id: 'social_momentum', name: 'Social Momentum' },
      { id: 'stealth_accumulation', name: 'Stealth Accumulation' },
      { id: 'dev_locked', name: 'Dev Locked & Loaded' },
    ];

    for (const strat of defaultStrategies) {
      if (!this.strategyPerformance.has(strat.id)) {
        this.strategyPerformance.set(strat.id, {
          strategyId: strat.id,
          name: strat.name,
          winRate: 0,
          avgROI: 0,
          sharpeRatio: 0,
          maxDrawdown: 0,
          totalTrades: 0,
          profitFactor: 0,
          isActive: true,
          weight: this.modelState.strategyWeights[strat.id] || 1.0,
          recentWinRate: 0,
        });
      }
    }
  }

  private getDefaultModelState(): ModelState {
    return {
      version: 1,
      trainedAt: 0,
      trainingSize: 0,
      accuracy: 0,
      featureWeights: [],
      strategyWeights: {},
      classificationThresholds: {
        highProbability: 0.7,
        mediumProbability: 0.45,
        rugRisk: 0.3,
      },
      reinforcementState: {
        rewards: {},
        penalties: {},
        positionSizeMultipliers: {},
      },
    };
  }

  // ============================================================
  // DATABASE HELPERS (uses existing db module internally)
  // ============================================================

  private queryDB(sql: string, params?: any[]): any {
    // Access the underlying better-sqlite3 instance through the db module
    return (db as any).db?.prepare(sql).get(...(params || []));
  }

  private queryAllDB(sql: string, params?: any[]): any[] {
    return (db as any).db?.prepare(sql).all(...(params || [])) || [];
  }

  private execDB(sql: string, params?: any[]): void {
    if (params) {
      (db as any).db?.prepare(sql).run(...params);
    } else {
      (db as any).db?.exec(sql);
    }
  }

  // ============================================================
  // INITIALIZATION (create ML tables)
  // ============================================================

  initializeDatabase(): void {
    try {
      this.execDB(`
        CREATE TABLE IF NOT EXISTS ml_model_state (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.execDB(`
        CREATE TABLE IF NOT EXISTS ml_trade_history (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.execDB(`
        CREATE TABLE IF NOT EXISTS ml_feature_weights (
          feature TEXT PRIMARY KEY,
          weight REAL,
          correlation_5x REAL,
          correlation_10x REAL,
          correlation_100x REAL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      logger.info('ML database tables initialized');
    } catch (error) {
      logger.error('Error initializing ML database:', error);
    }
  }

  // ============================================================
  // TRADE RECORD BUILDER (helper for integration)
  // ============================================================

  buildTradeRecord(
    position: TradePosition,
    analysis: AnalysisResult,
    strategyUsed: string
  ): TradeRecord {
    const features = this.extractFeatures(analysis);
    const roi = position.pnlPercentage;
    const profitMultiple = roi > 0 ? 1 + (roi / 100) : roi / 100;

    return {
      id: position.id,
      features,
      entryPrice: position.entryPrice,
      exitPrice: position.currentPrice,
      roi,
      maxDrawdown: Math.abs(Math.min(0, roi)),
      timeHeldMinutes: position.closedAt
        ? (new Date(position.closedAt).getTime() - new Date(position.openedAt).getTime()) / 60000
        : 0,
      strategyUsed,
      outcome: roi > 0 ? 'win' : 'loss',
      profitMultiple: Math.max(0, profitMultiple),
      timestamp: Date.now(),
      isReal: position.type === 'real',
    };
  }
}

// Export singleton
export const mlEngine = new MLStrategyEngine();
export default mlEngine;
