/**
 * Risk Manager - Centralized risk control for all trading operations
 *
 * Implements:
 * - Position sizing based on ML confidence and strategy weight
 * - Max exposure per user
 * - Daily loss limits
 * - Rug/honeypot blacklist
 * - Slippage control
 * - Liquidity checks
 * - Honeypot detection heuristics
 * - Gas fee awareness
 * - Trade gating (block if confidence < threshold)
 */

import { AnalysisResult, TradePosition } from '../types';
import { config, TRADING_PRESETS } from '../config';
import { mlEngine, MLPrediction } from '../ml/mlStrategyEngine';
import { StrategyRecommendation } from '../strategy/strategyEngine';
import db from '../database';
import logger from '../utils/logger';

// ============================================================
// TYPES
// ============================================================

export interface RiskAssessment {
  allowed: boolean;
  maxPositionSize: number;
  adjustedPositionSize: number;
  riskScore: number;
  warnings: string[];
  blockers: string[];
  slippageLimit: number;
  isSimulationOnly: boolean;
  reasoning: string;
}

export interface UserRiskProfile {
  userId: number;
  maxExposureSol: number;
  dailyLossLimitSol: number;
  currentExposure: number;
  dailyPnL: number;
  openPositionCount: number;
  maxPositions: number;
  riskTolerance: 'low' | 'medium' | 'high';
  isLocked: boolean;
}

export interface BlacklistEntry {
  contractAddress: string;
  reason: string;
  addedAt: number;
  severity: 'warning' | 'block';
}

// ============================================================
// RISK MANAGER
// ============================================================

export class RiskManager {
  private blacklist: Map<string, BlacklistEntry> = new Map();
  private dailyPnL: Map<number, { pnl: number; date: string }> = new Map();
  private userExposure: Map<number, number> = new Map();
  private lockedUsers: Map<number, { lockedAt: string; reason: string }> = new Map();
  private tokenCategories: Map<string, string> = new Map(); // Token -> category mapping for correlation

  // Risk parameters
  private globalKillSwitch: boolean = false;
  private minLiquidityForReal: number = 10000;  // $10K min liquidity for real trades
  private minLiquidityForSim: number = 3000;    // $3K min for simulation
  private maxSlippageBps: number = 500;          // 5% max slippage
  private minConfidenceForReal: number = 55;     // ML confidence threshold
  private maxDrawdownBeforeLock: number = 50;    // % daily drawdown to lock trading
  private honeypotScoreThreshold: number = 0.6;  // Above this = blocked
  private maxCorrelatedExposure: number = 0.5;   // Max 50% exposure to correlated assets
  private maxSingleTokenExposure: number = 0.25; // Max 25% in any single token

  constructor() {
    this.loadBlacklist();
    this.initializeTables();
    logger.info('RiskManager initialized');
  }

  // ============================================================
  // CORE: Assess trade risk
  // ============================================================

  assessTrade(
    analysis: AnalysisResult,
    userId: number,
    recommendation?: StrategyRecommendation,
    isReal: boolean = false
  ): RiskAssessment {
    const warnings: string[] = [];
    const blockers: string[] = [];
    let allowed = true;
    let isSimulationOnly = !isReal;

    // 1. Kill switch check
    if (this.globalKillSwitch) {
      blockers.push('Global kill switch is active');
      allowed = false;
    }

    // 2. Blacklist check
    const blacklisted = this.blacklist.get(analysis.token.contractAddress);
    if (blacklisted) {
      if (blacklisted.severity === 'block') {
        blockers.push(`Token blacklisted: ${blacklisted.reason}`);
        allowed = false;
      } else {
        warnings.push(`Token flagged: ${blacklisted.reason}`);
      }
    }

    // 3. Liquidity check
    const minLiquidity = isReal ? this.minLiquidityForReal : this.minLiquidityForSim;
    if (analysis.token.liquidity < minLiquidity) {
      if (isReal) {
        blockers.push(`Liquidity $${analysis.token.liquidity.toFixed(0)} < minimum $${minLiquidity}`);
        allowed = false;
      } else {
        warnings.push(`Low liquidity: $${analysis.token.liquidity.toFixed(0)}`);
      }
    }

    // 4. Honeypot / Rug detection
    const honeypotScore = this.computeHoneypotScore(analysis);
    if (honeypotScore >= this.honeypotScoreThreshold) {
      blockers.push(`Honeypot risk: ${(honeypotScore * 100).toFixed(0)}% probability`);
      allowed = false;
      // Auto-blacklist
      this.addToBlacklist(analysis.token.contractAddress, 'Honeypot detection', 'block');
    } else if (honeypotScore >= 0.4) {
      warnings.push(`Elevated rug risk: ${(honeypotScore * 100).toFixed(0)}%`);
    }

    // 5. ML confidence check
    const mlPrediction = recommendation?.mlPrediction || mlEngine.predict(analysis);
    if (isReal && mlPrediction.confidenceScore < this.minConfidenceForReal) {
      isSimulationOnly = true;
      warnings.push(`ML confidence ${mlPrediction.confidenceScore}% < threshold ${this.minConfidenceForReal}% - simulation only`);
    }

    // 6. User risk limits
    const userProfile = this.getUserRiskProfile(userId);
    if (userProfile.isLocked) {
      blockers.push('User trading locked (daily loss limit hit)');
      allowed = false;
    }

    if (userProfile.openPositionCount >= userProfile.maxPositions) {
      blockers.push(`Max positions reached (${userProfile.maxPositions})`);
      allowed = false;
    }

    // 7. Position sizing
    const baseSize = recommendation?.positionSize || this.calculateBasePositionSize(analysis, userId);
    const adjustedSize = this.adjustPositionSize(baseSize, analysis, userProfile, mlPrediction);

    // 8. Exposure check
    if (userProfile.currentExposure + adjustedSize > userProfile.maxExposureSol) {
      if (isReal) {
        blockers.push(`Exposure limit: current ${userProfile.currentExposure.toFixed(2)} + ${adjustedSize.toFixed(2)} > max ${userProfile.maxExposureSol}`);
        allowed = false;
      } else {
        warnings.push('Would exceed exposure limit for real trading');
      }
    }

    // 8.5 Portfolio correlation check
    const correlationRisk = this.checkPortfolioCorrelation(analysis, userId, adjustedSize);
    if (correlationRisk.overExposed) {
      if (isReal) {
        blockers.push(`Correlated exposure too high: ${correlationRisk.reason}`);
        allowed = false;
      } else {
        warnings.push(`Correlated exposure warning: ${correlationRisk.reason}`);
      }
    }

    // 9. Daily loss limit check
    if (userProfile.dailyPnL < -userProfile.dailyLossLimitSol) {
      if (isReal) {
        blockers.push(`Daily loss limit hit: ${userProfile.dailyPnL.toFixed(2)} SOL`);
        allowed = false;
        this.lockUserTrading(userId);
      }
      warnings.push(`Daily PnL: ${userProfile.dailyPnL.toFixed(2)} SOL`);
    }

    // 10. Slippage
    const slippageLimit = this.calculateSlippageLimit(analysis);
    if (slippageLimit > this.maxSlippageBps) {
      warnings.push(`High expected slippage: ${(slippageLimit / 100).toFixed(1)}%`);
      if (isReal) {
        isSimulationOnly = true;
      }
    }

    const reasoning = blockers.length > 0
      ? `BLOCKED: ${blockers[0]}`
      : warnings.length > 0
        ? `ALLOWED with warnings: ${warnings[0]}`
        : 'ALLOWED: All risk checks passed';

    return {
      allowed: allowed && blockers.length === 0,
      maxPositionSize: baseSize,
      adjustedPositionSize: adjustedSize,
      riskScore: mlPrediction.riskScore,
      warnings,
      blockers,
      slippageLimit,
      isSimulationOnly,
      reasoning,
    };
  }

  // ============================================================
  // POSITION SIZING
  // ============================================================

  private calculateBasePositionSize(analysis: AnalysisResult, userId: number): number {
    const settings = db.getUserSettings(userId);
    const preset = TRADING_PRESETS[settings?.preset || config.trading.defaultPreset] || TRADING_PRESETS.balanced;
    return preset.maxPositionSizeSol;
  }

  private adjustPositionSize(
    baseSize: number,
    analysis: AnalysisResult,
    profile: UserRiskProfile,
    ml: MLPrediction
  ): number {
    let size = baseSize;

    // Scale by ML confidence (0.3x at 30% confidence, 1.5x at 90%+)
    const confidenceMultiplier = 0.3 + (ml.confidenceScore / 100) * 1.2;
    size *= confidenceMultiplier;

    // Scale by risk tolerance
    const toleranceMultiplier = profile.riskTolerance === 'high' ? 1.5
      : profile.riskTolerance === 'low' ? 0.5
      : 1.0;
    size *= toleranceMultiplier;

    // Reduce if already exposed
    const exposureRatio = profile.currentExposure / profile.maxExposureSol;
    if (exposureRatio > 0.7) size *= 0.5;
    else if (exposureRatio > 0.5) size *= 0.75;

    // Reduce if daily PnL is negative
    if (profile.dailyPnL < 0) {
      const drawdownRatio = Math.abs(profile.dailyPnL) / profile.dailyLossLimitSol;
      size *= Math.max(0.3, 1 - drawdownRatio);
    }

    // Floor at 0.01 SOL, cap at base * 2
    return Math.max(0.01, Math.min(size, baseSize * 2));
  }

  // ============================================================
  // PORTFOLIO CORRELATION
  // ============================================================

  /**
   * Check if adding this position would over-expose user to correlated assets
   */
  private checkPortfolioCorrelation(
    analysis: AnalysisResult,
    userId: number,
    positionSize: number
  ): { overExposed: boolean; reason: string; correlatedExposure: number } {
    const openPositions = db.getOpenPositions(userId);
    if (openPositions.length === 0) {
      return { overExposed: false, reason: '', correlatedExposure: 0 };
    }

    // Categorize the new token
    const newCategory = this.categorizeToken(analysis);
    this.tokenCategories.set(analysis.token.contractAddress, newCategory);

    // Calculate total exposure and exposure by category
    let totalExposure = positionSize;
    const categoryExposure: Map<string, number> = new Map();
    categoryExposure.set(newCategory, positionSize);

    for (const position of openPositions) {
      totalExposure += position.solInvested;

      // Get or infer category
      let category = this.tokenCategories.get(position.contractAddress);
      if (!category) {
        // Infer from symbol/name
        category = this.inferCategory(position.symbol);
        this.tokenCategories.set(position.contractAddress, category);
      }

      const existing = categoryExposure.get(category) || 0;
      categoryExposure.set(category, existing + position.solInvested);
    }

    // Check if any category exceeds threshold
    for (const [category, exposure] of categoryExposure) {
      const ratio = exposure / totalExposure;
      if (ratio > this.maxCorrelatedExposure) {
        return {
          overExposed: true,
          reason: `${(ratio * 100).toFixed(0)}% in ${category} tokens (max ${this.maxCorrelatedExposure * 100}%)`,
          correlatedExposure: ratio,
        };
      }
    }

    // Check single token exposure
    const singleTokenRatio = positionSize / totalExposure;
    if (singleTokenRatio > this.maxSingleTokenExposure) {
      return {
        overExposed: true,
        reason: `${(singleTokenRatio * 100).toFixed(0)}% in single token (max ${this.maxSingleTokenExposure * 100}%)`,
        correlatedExposure: singleTokenRatio,
      };
    }

    return { overExposed: false, reason: '', correlatedExposure: 0 };
  }

  /**
   * Categorize a token based on its characteristics
   */
  private categorizeToken(analysis: AnalysisResult): string {
    const name = (analysis.token.name || '').toLowerCase();
    const symbol = (analysis.token.symbol || '').toLowerCase();
    const mc = analysis.token.marketCap;

    // Check for common meme categories
    if (name.includes('dog') || name.includes('shiba') || name.includes('inu') ||
        symbol.includes('dog') || name.includes('puppy') || name.includes('woof')) {
      return 'dog_meme';
    }
    if (name.includes('cat') || name.includes('kitty') || name.includes('meow') ||
        symbol.includes('cat') || name.includes('feline')) {
      return 'cat_meme';
    }
    if (name.includes('pepe') || name.includes('frog') || name.includes('kek')) {
      return 'pepe_meme';
    }
    if (name.includes('ai') || name.includes('gpt') || name.includes('neural') ||
        name.includes('bot') || name.includes('intelligence')) {
      return 'ai_narrative';
    }
    if (name.includes('trump') || name.includes('biden') || name.includes('political') ||
        name.includes('election') || name.includes('maga')) {
      return 'political';
    }
    if (name.includes('elon') || name.includes('musk') || name.includes('doge') ||
        name.includes('tesla')) {
      return 'elon_meme';
    }

    // Categorize by market cap
    if (mc < 50000) return 'micro_cap';
    if (mc < 500000) return 'low_cap';
    if (mc < 5000000) return 'mid_cap';
    return 'high_cap';
  }

  /**
   * Infer category from symbol/name when we don't have full analysis
   */
  private inferCategory(symbol: string): string {
    const s = symbol.toLowerCase();
    if (s.includes('dog') || s.includes('shib') || s.includes('inu')) return 'dog_meme';
    if (s.includes('cat') || s.includes('kit')) return 'cat_meme';
    if (s.includes('pepe') || s.includes('frog')) return 'pepe_meme';
    if (s.includes('ai') || s.includes('gpt')) return 'ai_narrative';
    return 'other';
  }

  /**
   * Get portfolio diversification report
   */
  getPortfolioDiversification(userId: number): { category: string; exposure: number; percentage: number }[] {
    const positions = db.getOpenPositions(userId);
    if (positions.length === 0) return [];

    const categoryExposure: Map<string, number> = new Map();
    let totalExposure = 0;

    for (const position of positions) {
      totalExposure += position.solInvested;
      let category = this.tokenCategories.get(position.contractAddress);
      if (!category) {
        category = this.inferCategory(position.symbol);
        this.tokenCategories.set(position.contractAddress, category);
      }
      categoryExposure.set(category, (categoryExposure.get(category) || 0) + position.solInvested);
    }

    return Array.from(categoryExposure.entries())
      .map(([category, exposure]) => ({
        category,
        exposure,
        percentage: (exposure / totalExposure) * 100,
      }))
      .sort((a, b) => b.percentage - a.percentage);
  }

  // ============================================================
  // HONEYPOT / RUG DETECTION
  // ============================================================

  private computeHoneypotScore(analysis: AnalysisResult): number {
    let score = 0;

    // Dev wallet not locked
    if (!analysis.fundamental.devWalletLocked) score += 0.2;
    // Liquidity not locked
    if (!analysis.fundamental.liquidityLocked) score += 0.25;
    // Very high holder concentration
    if (analysis.fundamental.holderConcentration > 0.8) score += 0.2;
    // Top holder owns too much
    if (analysis.fundamental.topHolderPercentage > 50) score += 0.2;
    // Very few holders
    if (analysis.fundamental.uniqueHolders < 50) score += 0.1;
    // Very low liquidity relative to market cap
    if (analysis.token.marketCap > 0 && analysis.token.liquidity / analysis.token.marketCap < 0.05) score += 0.15;
    // Bearish price action
    if (analysis.technical.priceAction === 'bearish') score += 0.05;

    return Math.min(1, score);
  }

  private calculateSlippageLimit(analysis: AnalysisResult): number {
    // Base slippage from config
    let slippage = config.trading.slippageBps;

    // Increase for low liquidity
    if (analysis.token.liquidity < 20000) slippage += 200;
    else if (analysis.token.liquidity < 50000) slippage += 100;

    // Increase for high volatility
    if (analysis.technical.volatility > 0.5) slippage += 150;

    return Math.min(slippage, this.maxSlippageBps);
  }

  // ============================================================
  // USER RISK PROFILES
  // ============================================================

  getUserRiskProfile(userId: number): UserRiskProfile {
    const settings = db.getUserSettings(userId);
    const preset = TRADING_PRESETS[settings?.preset || 'balanced'] || TRADING_PRESETS.balanced;
    const openPositions = db.getOpenPositions(userId);

    const currentExposure = openPositions.reduce((sum, p) => sum + p.solInvested, 0);

    const today = new Date().toISOString().split('T')[0];
    const dailyEntry = this.dailyPnL.get(userId);
    const dailyPnL = (dailyEntry && dailyEntry.date === today) ? dailyEntry.pnl : 0;

    const riskTolerance: 'low' | 'medium' | 'high' =
      preset.riskLevel === 'conservative' ? 'low' :
      preset.riskLevel === 'aggressive' || preset.riskLevel === 'degen' ? 'high' :
      'medium';

    // Check if user is locked (daily reset at midnight)
    const lockInfo = this.lockedUsers.get(userId);
    const isLocked = lockInfo ? lockInfo.lockedAt === today : false;

    // Clear stale locks from previous days
    if (lockInfo && lockInfo.lockedAt !== today) {
      this.lockedUsers.delete(userId);
    }

    return {
      userId,
      maxExposureSol: preset.maxPositionSizeSol * preset.maxOpenPositions,
      dailyLossLimitSol: preset.maxPositionSizeSol * 3,
      currentExposure,
      dailyPnL,
      openPositionCount: openPositions.length,
      maxPositions: preset.maxOpenPositions,
      riskTolerance,
      isLocked,
    };
  }

  recordDailyPnL(userId: number, pnl: number): void {
    const today = new Date().toISOString().split('T')[0];
    const entry = this.dailyPnL.get(userId);
    if (entry && entry.date === today) {
      entry.pnl += pnl;
    } else {
      this.dailyPnL.set(userId, { pnl, date: today });
    }
  }

  private lockUserTrading(userId: number, reason: string = 'Daily loss limit hit'): void {
    const today = new Date().toISOString().split('T')[0];
    this.lockedUsers.set(userId, { lockedAt: today, reason });
    logger.warn(`🔒 Trading LOCKED for user ${userId} - ${reason}`);
  }

  /**
   * Manually unlock a user's trading (admin function)
   */
  unlockUserTrading(userId: number): boolean {
    const wasLocked = this.lockedUsers.has(userId);
    this.lockedUsers.delete(userId);
    if (wasLocked) {
      logger.info(`🔓 Trading UNLOCKED for user ${userId}`);
    }
    return wasLocked;
  }

  /**
   * Check if user is currently locked
   */
  isUserLocked(userId: number): boolean {
    const lockInfo = this.lockedUsers.get(userId);
    if (!lockInfo) return false;

    const today = new Date().toISOString().split('T')[0];
    if (lockInfo.lockedAt !== today) {
      // Auto-unlock if lock was from a previous day
      this.lockedUsers.delete(userId);
      return false;
    }
    return true;
  }

  // ============================================================
  // BLACKLIST
  // ============================================================

  addToBlacklist(contractAddress: string, reason: string, severity: 'warning' | 'block' = 'warning'): void {
    this.blacklist.set(contractAddress, {
      contractAddress, reason, addedAt: Date.now(), severity,
    });
    this.saveBlacklist();
    logger.info(`Blacklisted ${contractAddress}: ${reason} (${severity})`);
  }

  removeFromBlacklist(contractAddress: string): boolean {
    const removed = this.blacklist.delete(contractAddress);
    if (removed) this.saveBlacklist();
    return removed;
  }

  isBlacklisted(contractAddress: string): boolean {
    const entry = this.blacklist.get(contractAddress);
    return entry?.severity === 'block';
  }

  getBlacklist(): BlacklistEntry[] {
    return Array.from(this.blacklist.values());
  }

  // ============================================================
  // KILL SWITCH
  // ============================================================

  activateKillSwitch(): void {
    this.globalKillSwitch = true;
    logger.warn('🚨 GLOBAL KILL SWITCH ACTIVATED - All trading disabled');
  }

  deactivateKillSwitch(): void {
    this.globalKillSwitch = false;
    logger.info('Kill switch deactivated');
  }

  isKillSwitchActive(): boolean {
    return this.globalKillSwitch;
  }

  // ============================================================
  // REPORT
  // ============================================================

  generateReport(userId: number): string {
    const profile = this.getUserRiskProfile(userId);

    let report = `🛡️ *Risk Manager Report*\n\n`;
    report += `👤 *User Risk Profile*\n`;
    report += `• Tolerance: ${profile.riskTolerance}\n`;
    report += `• Exposure: ${profile.currentExposure.toFixed(2)} / ${profile.maxExposureSol.toFixed(2)} SOL\n`;
    report += `• Open Positions: ${profile.openPositionCount} / ${profile.maxPositions}\n`;
    report += `• Daily PnL: ${profile.dailyPnL.toFixed(2)} SOL (limit: -${profile.dailyLossLimitSol.toFixed(2)})\n`;
    report += `• Trading Locked: ${profile.isLocked ? '🔒 Yes' : '🔓 No'}\n\n`;

    report += `🚨 *System Status*\n`;
    report += `• Kill Switch: ${this.globalKillSwitch ? '🔴 ACTIVE' : '🟢 OFF'}\n`;
    report += `• Blacklisted Tokens: ${this.blacklist.size}\n`;
    report += `• Min Liquidity (Real): $${this.minLiquidityForReal}\n`;
    report += `• Min Confidence (Real): ${this.minConfidenceForReal}%\n`;
    report += `• Max Slippage: ${(this.maxSlippageBps / 100).toFixed(1)}%\n`;

    return report;
  }

  // ============================================================
  // PERSISTENCE
  // ============================================================

  private initializeTables(): void {
    try {
      (db as any).db?.exec(`
        CREATE TABLE IF NOT EXISTS risk_blacklist (
          contract_address TEXT PRIMARY KEY,
          reason TEXT,
          severity TEXT,
          added_at INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    } catch (error) {
      logger.error('Error initializing risk tables:', error);
    }
  }

  private loadBlacklist(): void {
    try {
      this.initializeTables();
      const rows = (db as any).db?.prepare('SELECT * FROM risk_blacklist').all() || [];
      for (const row of rows as any[]) {
        this.blacklist.set(row.contract_address, {
          contractAddress: row.contract_address,
          reason: row.reason,
          addedAt: row.added_at,
          severity: row.severity,
        });
      }
      logger.info(`Loaded ${this.blacklist.size} blacklisted tokens`);
    } catch {}
  }

  private saveBlacklist(): void {
    try {
      const stmt = (db as any).db?.prepare(
        `INSERT OR REPLACE INTO risk_blacklist (contract_address, reason, severity, added_at) VALUES (?, ?, ?, ?)`
      );
      for (const [addr, entry] of this.blacklist) {
        stmt?.run(addr, entry.reason, entry.severity, entry.addedAt);
      }
    } catch (error) {
      logger.error('Error saving blacklist:', error);
    }
  }
}

export const riskManager = new RiskManager();
export default riskManager;
