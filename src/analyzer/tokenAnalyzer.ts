import { dexScreener, birdeye, helius, jupiter } from '../services/apiClients';
import { TokenData, AnalysisResult, WalletSignal, TechnicalSignal, FundamentalSignal, SocialSignal, RunnerPattern } from '../types';
import { RUNNER_PATTERNS } from '../config';
import logger from '../utils/logger';
import db from '../database';

export class TokenAnalyzer {
  async analyzeToken(contractAddress: string): Promise<AnalysisResult | null> {
    try {
      logger.info(`Starting analysis for token: ${contractAddress}`);

      // Fetch data from multiple sources
      const [dexData, birdeyeData, heliusData] = await Promise.all([
        dexScreener.getTokenData(contractAddress),
        birdeye.getTokenOverview(contractAddress),
        helius.getAsset(contractAddress),
      ]);

      if (!dexData) {
        logger.warn(`No DexScreener data found for ${contractAddress}`);
        return null;
      }

      // Build token data
      const tokenData: TokenData = {
        contractAddress,
        symbol: dexData.baseToken?.symbol || 'UNKNOWN',
        name: dexData.baseToken?.name || 'Unknown Token',
        price: parseFloat(dexData.priceUsd || '0'),
        priceChange24h: dexData.priceChange?.h24 || 0,
        volume24h: parseFloat(dexData.volume?.h24 || '0'),
        liquidity: parseFloat(dexData.liquidity?.usd || '0'),
        marketCap: parseFloat(dexData.marketCap || '0'),
        holders: await helius.getTokenHolders(contractAddress) || 0,
        createdAt: new Date(dexData.pairCreatedAt || Date.now()),
        dexScreenerData: dexData,
        birdeyeData: birdeyeData,
      };

      // Analyze different aspects
      const walletSignals = await this.analyzeWallets(contractAddress, dexData);
      const technical = this.analyzeTechnical(tokenData, dexData);
      const fundamental = this.analyzeFundamental(tokenData, dexData, birdeyeData);
      const social = this.analyzeSocial(tokenData, dexData);

      // Match against patterns
      const matchedPatterns = this.matchPatterns(walletSignals, technical, fundamental, social);

      // Calculate overall score
      const overallScore = this.calculateOverallScore(walletSignals, technical, fundamental, social, matchedPatterns);
      const confidence = this.calculateConfidence(matchedPatterns);

      // Generate recommendation
      const recommendation = this.generateRecommendation(overallScore, confidence);
      const reasoning = this.generateReasoning(tokenData, matchedPatterns, overallScore);

      const result: AnalysisResult = {
        token: tokenData,
        walletSignals,
        technical,
        fundamental,
        social,
        overallScore,
        confidence,
        recommendation,
        matchedPatterns,
        reasoning,
      };

      logger.info(`Analysis complete for ${tokenData.symbol}: Score ${overallScore.toFixed(2)}, Confidence ${confidence.toFixed(2)}`);

      return result;
    } catch (error) {
      logger.error(`Error analyzing token ${contractAddress}:`, error);
      return null;
    }
  }

  private async analyzeWallets(contractAddress: string, dexData: any): Promise<WalletSignal[]> {
    const signals: WalletSignal[] = [];

    // Analyze based on volume/liquidity patterns - high volume with good liquidity suggests smart money
    const volume24h = parseFloat(dexData.volume?.h24 || '0');
    const liquidity = parseFloat(dexData.liquidity?.usd || '0');
    const volumeToLiquidityRatio = liquidity > 0 ? volume24h / liquidity : 0;

    // High volume relative to liquidity can indicate smart money accumulation
    const isSmartMoney = volumeToLiquidityRatio > 2 && volume24h > 50000;

    // Whale detection based on large transactions (high volume in short time)
    const volume1h = parseFloat(dexData.volume?.h1 || '0');
    const volume6h = parseFloat(dexData.volume?.h6 || '0');
    const isWhale = volume1h > 10000 && (volume1h / Math.max(volume6h / 6, 1)) > 3;

    // Check transaction count patterns
    const txns24h = dexData.txns?.h24 || { buys: 0, sells: 0 };
    const buyPressure = txns24h.buys / Math.max(txns24h.sells, 1);

    signals.push({
      isSmartMoney,
      isWhale,
      isKnownWinner: buyPressure > 2 && volume24h > 100000, // High buy pressure with volume
      walletAge: 0, // Would need wallet-specific data
      profitRate: buyPressure > 1.5 ? 0.6 : 0.4, // Estimate based on buy pressure
      recentWins: buyPressure > 2 ? 3 : (buyPressure > 1.5 ? 1 : 0),
    });

    return signals;
  }

  private analyzeTechnical(tokenData: TokenData, dexData: any): TechnicalSignal {
    const volumeChange = dexData.volume?.h24 / (dexData.volume?.h6 || 1);
    const volumeBreakout = volumeChange > 2.0; // 100%+ volume increase

    const liquidityScore = Math.min(tokenData.liquidity / 100000, 1.0); // Normalized to $100k

    let priceAction: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    if (tokenData.priceChange24h > 20) priceAction = 'bullish';
    else if (tokenData.priceChange24h < -20) priceAction = 'bearish';

    // Simple RSI estimation from price change
    const rsi = 50 + (tokenData.priceChange24h / 2);

    const volatility = Math.abs(tokenData.priceChange24h) / 100;

    return {
      volumeBreakout,
      liquidityScore,
      priceAction,
      rsi: Math.max(0, Math.min(100, rsi)),
      volatility,
    };
  }

  private analyzeFundamental(tokenData: TokenData, dexData: any, birdeyeData: any): FundamentalSignal {
    // Extract security data from Birdeye if available
    const securityData = birdeyeData?.security || {};

    // Top holder percentage from Birdeye or estimate from holder count
    let topHolderPercentage = securityData.top10HolderPercent || 0;
    if (!topHolderPercentage && tokenData.holders > 0) {
      // Estimate: fewer holders = higher concentration
      topHolderPercentage = tokenData.holders < 100 ? 80 :
                           tokenData.holders < 500 ? 50 :
                           tokenData.holders < 1000 ? 30 : 20;
    }

    const holderConcentration = topHolderPercentage / 100;
    const tokenAge = (Date.now() - tokenData.createdAt.getTime()) / (1000 * 60 * 60); // hours

    // Check if liquidity is locked (from Birdeye or DexScreener)
    const liquidityLocked = securityData.isLpBurned ||
                           securityData.lpLocked ||
                           dexData.info?.socials?.some((s: any) =>
                             s.type === 'lplock' || s.url?.includes('lock')
                           ) || false;

    // Dev wallet checks
    const devWalletLocked = securityData.ownershipRenounced ||
                           securityData.mintDisabled ||
                           securityData.freezeDisabled || false;

    return {
      holderConcentration,
      topHolderPercentage,
      uniqueHolders: tokenData.holders,
      devWalletLocked,
      liquidityLocked,
      tokenAge,
    };
  }

  private analyzeSocial(tokenData: TokenData, dexData: any): SocialSignal {
    // Use DexScreener social data if available
    const socials = dexData.info?.socials || [];
    const hasTwitter = socials.some((s: any) => s.type === 'twitter');
    const hasTelegram = socials.some((s: any) => s.type === 'telegram');
    const hasWebsite = socials.some((s: any) => s.type === 'website');

    // Calculate social presence score
    const socialPresence = (hasTwitter ? 1 : 0) + (hasTelegram ? 1 : 0) + (hasWebsite ? 1 : 0);

    // Estimate trending score based on volume growth and social presence
    const volumeGrowth = dexData.volume?.h1 && dexData.volume?.h6 ?
      (parseFloat(dexData.volume.h1) / (parseFloat(dexData.volume.h6) / 6)) : 1;

    const trendingScore = Math.min(1, (volumeGrowth - 1) * 0.5 + (socialPresence * 0.2));

    // Determine sentiment from price action and buy/sell ratio
    const priceChange = tokenData.priceChange24h;
    const txns = dexData.txns?.h24 || { buys: 0, sells: 0 };
    const buyRatio = txns.buys / Math.max(txns.sells, 1);

    let sentiment: 'positive' | 'negative' | 'neutral' = 'neutral';
    if (priceChange > 20 && buyRatio > 1.2) sentiment = 'positive';
    else if (priceChange < -20 && buyRatio < 0.8) sentiment = 'negative';

    return {
      twitterMentions: hasTwitter ? 10 : 0, // Placeholder - would need Twitter API
      influencerEngagement: socialPresence > 2 ? 5 : socialPresence,
      sentiment,
      trendingScore: Math.max(0, Math.min(1, trendingScore)),
    };
  }

  private matchPatterns(
    walletSignals: WalletSignal[],
    technical: TechnicalSignal,
    fundamental: FundamentalSignal,
    social: SocialSignal
  ): RunnerPattern[] {
    const matched: RunnerPattern[] = [];

    for (const pattern of RUNNER_PATTERNS) {
      const score = this.scorePattern(pattern, walletSignals, technical, fundamental, social);

      if (score > 0.5) { // Pattern matches if score > 50%
        // Get learning data for this pattern
        const performance = db.getPatternPerformance(pattern.id);

        matched.push({
          ...pattern,
          confidence: score,
          successRate: performance.successRate,
          avgReturn: performance.avgReturn,
          sampleSize: performance.sampleSize,
        });
      }
    }

    // Sort by confidence
    return matched.sort((a, b) => b.confidence - a.confidence);
  }

  private scorePattern(
    pattern: any,
    walletSignals: WalletSignal[],
    technical: TechnicalSignal,
    fundamental: FundamentalSignal,
    social: SocialSignal
  ): number {
    let totalScore = 0;
    let totalWeight = 0;

    for (const signal of pattern.signals) {
      const value = this.getSignalValue(signal, walletSignals, technical, fundamental, social);

      if (value !== null) {
        const matches = this.evaluateSignal(signal, value);
        if (matches) {
          totalScore += signal.weight;
        }
        totalWeight += signal.weight;
      }
    }

    return totalWeight > 0 ? totalScore / totalWeight : 0;
  }

  private getSignalValue(
    signal: any,
    walletSignals: WalletSignal[],
    technical: TechnicalSignal,
    fundamental: FundamentalSignal,
    social: SocialSignal
  ): number | null {
    switch (signal.type) {
      case 'wallet':
        if (walletSignals.length === 0) return null;
        const wallet = walletSignals[0];
        if (signal.metric === 'isSmartMoney') return wallet.isSmartMoney ? 1 : 0;
        if (signal.metric === 'isWhale') return wallet.isWhale ? 1 : 0;
        if (signal.metric === 'profitRate') return wallet.profitRate;
        break;

      case 'technical':
        if (signal.metric === 'volumeBreakout') return technical.volumeBreakout ? 1 : 0;
        if (signal.metric === 'liquidityScore') return technical.liquidityScore;
        if (signal.metric === 'priceAction') return technical.priceAction === 'bullish' ? 1 : 0;
        if (signal.metric === 'volatility') return technical.volatility;
        break;

      case 'fundamental':
        if (signal.metric === 'tokenAge') return fundamental.tokenAge;
        if (signal.metric === 'liquidityLocked') return fundamental.liquidityLocked ? 1 : 0;
        if (signal.metric === 'uniqueHolders') return fundamental.uniqueHolders;
        if (signal.metric === 'topHolderPercentage') return fundamental.topHolderPercentage;
        if (signal.metric === 'holderConcentration') return fundamental.holderConcentration;
        if (signal.metric === 'devWalletLocked') return fundamental.devWalletLocked ? 1 : 0;
        break;

      case 'social':
        if (signal.metric === 'twitterMentions') return social.twitterMentions;
        if (signal.metric === 'influencerEngagement') return social.influencerEngagement;
        if (signal.metric === 'sentiment') return social.sentiment === 'positive' ? 1 : 0;
        if (signal.metric === 'trendingScore') return social.trendingScore;
        break;
    }

    return null;
  }

  private evaluateSignal(signal: any, value: number): boolean {
    switch (signal.operator) {
      case 'gt': return value > signal.value;
      case 'gte': return value >= signal.value;
      case 'lt': return value < signal.value;
      case 'lte': return value <= signal.value;
      case 'eq': return value === signal.value;
      default: return false;
    }
  }

  private calculateOverallScore(
    walletSignals: WalletSignal[],
    technical: TechnicalSignal,
    fundamental: FundamentalSignal,
    social: SocialSignal,
    matchedPatterns: RunnerPattern[]
  ): number {
    let score = 0;

    // Technical signals (40%)
    if (technical.volumeBreakout) score += 15;
    score += technical.liquidityScore * 15;
    if (technical.priceAction === 'bullish') score += 10;

    // Fundamental signals (30%)
    const holderScore = Math.min(fundamental.uniqueHolders / 1000, 1) * 15;
    score += holderScore;
    if (fundamental.liquidityLocked) score += 7.5;
    if (fundamental.devWalletLocked) score += 7.5;

    // Social signals (15%)
    score += social.trendingScore * 15;

    // Pattern matches (15%)
    if (matchedPatterns.length > 0) {
      const topPattern = matchedPatterns[0];
      score += topPattern.confidence * 15;
    }

    return Math.min(100, score);
  }

  private calculateConfidence(matchedPatterns: RunnerPattern[]): number {
    if (matchedPatterns.length === 0) return 0.3;

    const topPattern = matchedPatterns[0];

    // Base confidence from pattern match
    let confidence = topPattern.confidence;

    // Boost from learning data
    if (topPattern.sampleSize > 10) {
      const learningBoost = Math.min(topPattern.successRate * 0.3, 0.3);
      confidence += learningBoost;
    }

    return Math.min(0.95, confidence);
  }

  private generateRecommendation(score: number, confidence: number): 'strong_buy' | 'buy' | 'hold' | 'avoid' {
    if (score >= 75 && confidence >= 0.75) return 'strong_buy';
    if (score >= 60 && confidence >= 0.6) return 'buy';
    if (score >= 45) return 'hold';
    return 'avoid';
  }

  private generateReasoning(tokenData: TokenData, matchedPatterns: RunnerPattern[], score: number): string {
    let reasoning = `**${tokenData.symbol} Analysis**\n\n`;

    reasoning += `💰 Price: $${tokenData.price.toFixed(8)}\n`;
    reasoning += `📊 24h Change: ${tokenData.priceChange24h.toFixed(2)}%\n`;
    reasoning += `💧 Liquidity: $${tokenData.liquidity.toLocaleString()}\n`;
    reasoning += `📈 Volume 24h: $${tokenData.volume24h.toLocaleString()}\n\n`;

    if (matchedPatterns.length > 0) {
      reasoning += `🎯 **Matched Patterns:**\n`;
      matchedPatterns.forEach(pattern => {
        reasoning += `• ${pattern.name} (${(pattern.confidence * 100).toFixed(0)}% match)\n`;
        if (pattern.sampleSize > 0) {
          reasoning += `  ↳ Win Rate: ${(pattern.successRate * 100).toFixed(0)}% | Avg Return: ${pattern.avgReturn.toFixed(0)}%\n`;
        }
      });
      reasoning += '\n';
    }

    reasoning += `📊 **Overall Score: ${score.toFixed(0)}/100**\n`;

    return reasoning;
  }
}

export default new TokenAnalyzer();
