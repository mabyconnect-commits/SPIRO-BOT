import axios, { AxiosError } from 'axios';
import { config } from '../config';
import logger from '../utils/logger';
import { TokenData } from '../types';

// API configuration
const API_TIMEOUT = 15000; // 15 seconds
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // Exponential backoff

// Helper function for delay
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function for retry with exponential backoff
async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries: number = MAX_RETRIES
): Promise<T | null> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      const isLastAttempt = attempt === maxRetries - 1;

      // Check if it's a rate limit or server error (worth retrying)
      const axiosError = error as AxiosError;
      const statusCode = axiosError?.response?.status;
      const isRetryable = !statusCode || statusCode >= 500 || statusCode === 429;

      if (!isRetryable || isLastAttempt) {
        break;
      }

      const delay = RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
      logger.warn(`${operationName} attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  logger.error(`${operationName} failed after ${maxRetries} attempts:`, lastError);
  return null;
}

// Error type for more specific error handling
export interface ApiError {
  type: 'timeout' | 'rate_limit' | 'not_found' | 'server_error' | 'network' | 'unknown';
  message: string;
  statusCode?: number;
}

function classifyError(error: unknown): ApiError {
  const axiosError = error as AxiosError;

  if (axiosError?.code === 'ECONNABORTED' || axiosError?.code === 'ETIMEDOUT') {
    return { type: 'timeout', message: 'Request timed out' };
  }

  if (axiosError?.code === 'ENOTFOUND' || axiosError?.code === 'ECONNREFUSED') {
    return { type: 'network', message: 'Network error - unable to reach API' };
  }

  const statusCode = axiosError?.response?.status;
  if (statusCode === 429) {
    return { type: 'rate_limit', message: 'Rate limited - too many requests', statusCode };
  }
  if (statusCode === 404) {
    return { type: 'not_found', message: 'Token not found', statusCode };
  }
  if (statusCode && statusCode >= 500) {
    return { type: 'server_error', message: 'API server error', statusCode };
  }

  return { type: 'unknown', message: String(error), statusCode };
}

export class DexScreenerClient {
  private baseUrl = 'https://api.dexscreener.com/latest/dex';

  async getTokenData(contractAddress: string): Promise<any> {
    return withRetry(async () => {
      const response = await axios.get(
        `${this.baseUrl}/tokens/${contractAddress}`,
        { timeout: API_TIMEOUT }
      );

      const pair = response.data.pairs?.[0];
      if (!pair) {
        logger.debug(`No pairs found on DexScreener for ${contractAddress}`);
        return null;
      }

      return pair;
    }, `DexScreener.getTokenData(${contractAddress.substring(0, 8)}...)`);
  }

  // Get token data with detailed error info
  async getTokenDataWithError(contractAddress: string): Promise<{ data: any; error?: ApiError }> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/tokens/${contractAddress}`,
        { timeout: API_TIMEOUT }
      );

      const pair = response.data.pairs?.[0];
      if (!pair) {
        return {
          data: null,
          error: { type: 'not_found', message: 'Token not listed on DexScreener yet' }
        };
      }

      return { data: pair };
    } catch (error) {
      return { data: null, error: classifyError(error) };
    }
  }

  async searchPairs(query: string): Promise<any[]> {
    const result = await withRetry(async () => {
      const response = await axios.get(
        `${this.baseUrl}/search?q=${query}`,
        { timeout: API_TIMEOUT }
      );
      return response.data.pairs || [];
    }, `DexScreener.searchPairs(${query})`);

    return result || [];
  }

  /**
   * Get new pairs from launchpads by searching for launchpad-related tokens
   * Since DexScreener doesn't have a bulk "get all pairs" endpoint,
   * we use the search API with launchpad keywords
   */
  async getNewPairs(): Promise<any[]> {
    const allPairs: any[] = [];
    const seenAddresses = new Set<string>();

    // Search for tokens from different launchpads
    const launchpadSearches = [
      'pumpfun',
      'pump.fun',
      'meteora',
      'raydium',
      'moonshot',
    ];

    // Also search for trending/new token indicators
    const trendingSearches = [
      'solana new',
      'sol meme',
    ];

    const allSearches = [...launchpadSearches, ...trendingSearches];

    for (const query of allSearches) {
      try {
        const pairs = await this.searchPairs(query);

        // Add unique pairs (by base token address)
        for (const pair of pairs) {
          const address = pair.baseToken?.address;
          if (address && !seenAddresses.has(address)) {
            // Only include Solana pairs
            if (pair.chainId === 'solana') {
              seenAddresses.add(address);
              allPairs.push(pair);
            }
          }
        }

        // Small delay to avoid rate limits
        await sleep(200);
      } catch (error) {
        logger.warn(`Search for "${query}" failed:`, error);
      }
    }

    logger.info(`DexScreener.getNewPairs: Found ${allPairs.length} unique Solana pairs from searches`);
    return allPairs;
  }

  /**
   * Get latest token profiles (tokens that have been updated/boosted recently)
   */
  async getLatestTokenProfiles(): Promise<any[]> {
    const result = await withRetry(async () => {
      const response = await axios.get(
        'https://api.dexscreener.com/token-profiles/latest/v1',
        { timeout: API_TIMEOUT }
      );
      // Filter for Solana tokens
      const profiles = response.data || [];
      return profiles.filter((p: any) => p.chainId === 'solana');
    }, 'DexScreener.getLatestTokenProfiles');

    return result || [];
  }

  /**
   * Get boosted tokens (tokens with active boosts)
   */
  async getTokenBoosts(): Promise<any[]> {
    const result = await withRetry(async () => {
      const response = await axios.get(
        'https://api.dexscreener.com/token-boosts/latest/v1',
        { timeout: API_TIMEOUT }
      );
      // Filter for Solana tokens
      const boosts = response.data || [];
      return boosts.filter((b: any) => b.chainId === 'solana');
    }, 'DexScreener.getTokenBoosts');

    return result || [];
  }

  /**
   * Filter pairs by DEX name (PumpFun, Raydium, Meteora, Orca, etc.)
   */
  filterByDex(pairs: any[], allowedDexes: string[]): any[] {
    return pairs.filter(pair => {
      const dexId = pair.dexId?.toLowerCase() || '';
      return allowedDexes.some(allowed => dexId.includes(allowed.toLowerCase()));
    });
  }

  /**
   * Check if a pair is from a launchpad/new token platform
   */
  isFromLaunchpad(pair: any): boolean {
    const dexId = pair.dexId?.toLowerCase() || '';
    const launchpads = [
      'pump',      // PumpFun
      'meteora',   // Meteora
      'raydium',   // Raydium (has launchpad)
      'moonshot',  // Moonshot
      'pump.fun',  // PumpFun alternative name
    ];
    return launchpads.some(lp => dexId.includes(lp));
  }
}

export class BirdeyeClient {
  private baseUrl = 'https://public-api.birdeye.so';
  private apiKey = config.apis.birdeye;

  async getTokenOverview(contractAddress: string): Promise<any> {
    if (!this.apiKey) {
      logger.debug('Birdeye API key not configured, skipping');
      return null;
    }

    return withRetry(async () => {
      const response = await axios.get(
        `${this.baseUrl}/defi/token_overview`,
        {
          params: { address: contractAddress },
          headers: { 'X-API-KEY': this.apiKey },
          timeout: API_TIMEOUT,
        }
      );
      return response.data.data;
    }, `Birdeye.getTokenOverview(${contractAddress.substring(0, 8)}...)`);
  }

  async getTokenSecurity(contractAddress: string): Promise<any> {
    if (!this.apiKey) return null;

    return withRetry(async () => {
      const response = await axios.get(
        `${this.baseUrl}/defi/token_security`,
        {
          params: { address: contractAddress },
          headers: { 'X-API-KEY': this.apiKey },
          timeout: API_TIMEOUT,
        }
      );
      return response.data.data;
    }, `Birdeye.getTokenSecurity(${contractAddress.substring(0, 8)}...)`);
  }
}

export class HeliusClient {
  private baseUrl = 'https://api.helius.xyz/v0';
  private rpcUrl = 'https://mainnet.helius-rpc.com';
  private apiKey = config.apis.helius;

  // Cache for holder snapshots (for change detection)
  private holderSnapshots: Map<string, { holders: any[]; timestamp: number }> = new Map();
  private snapshotTTL = 5 * 60 * 1000; // 5 minutes

  async getAsset(mintAddress: string): Promise<any> {
    if (!this.apiKey) {
      logger.debug('Helius API key not configured, skipping');
      return null;
    }

    return withRetry(async () => {
      const response = await axios.post(
        `${this.baseUrl}/token-metadata`,
        {
          mintAccounts: [mintAddress],
        },
        {
          params: { 'api-key': this.apiKey },
          timeout: API_TIMEOUT,
        }
      );
      return response.data[0];
    }, `Helius.getAsset(${mintAddress.substring(0, 8)}...)`);
  }

  async getTokenHolders(mintAddress: string): Promise<number | null> {
    if (!this.apiKey) {
      logger.debug('Helius API key not configured, skipping holders check');
      return null;
    }

    return withRetry(async () => {
      const response = await axios.get(
        `${this.baseUrl}/addresses/${mintAddress}/holders`,
        {
          params: { 'api-key': this.apiKey },
          timeout: API_TIMEOUT,
        }
      );
      return response.data.total || 0;
    }, `Helius.getTokenHolders(${mintAddress.substring(0, 8)}...)`);
  }

  /**
   * Get detailed holder distribution for a token
   */
  async getHolderDistribution(mintAddress: string, limit: number = 50): Promise<{
    totalHolders: number;
    topHolders: Array<{ address: string; balance: number; percentage: number }>;
  } | null> {
    if (!this.apiKey) {
      logger.debug('Helius API key not configured, skipping holder distribution');
      return null;
    }

    return withRetry(async () => {
      // Use Helius DAS API for token accounts
      const response = await axios.post(
        `${this.rpcUrl}/?api-key=${this.apiKey}`,
        {
          jsonrpc: '2.0',
          id: 'holder-distribution',
          method: 'getTokenAccounts',
          params: {
            mint: mintAddress,
            limit: limit,
            options: {
              showZeroBalance: false,
            }
          }
        },
        { timeout: API_TIMEOUT }
      );

      const accounts = response.data.result?.token_accounts || [];

      // Calculate total supply from holders (approximate)
      let totalBalance = 0;
      for (const account of accounts) {
        totalBalance += parseFloat(account.amount) || 0;
      }

      // Map to holder info with percentages
      const topHolders = accounts.map((account: any) => {
        const balance = parseFloat(account.amount) || 0;
        return {
          address: account.owner,
          balance,
          percentage: totalBalance > 0 ? (balance / totalBalance) * 100 : 0,
        };
      }).sort((a: any, b: any) => b.balance - a.balance);

      // Get total holder count
      const holderCount = await this.getTokenHolders(mintAddress);

      return {
        totalHolders: holderCount || topHolders.length,
        topHolders,
      };
    }, `Helius.getHolderDistribution(${mintAddress.substring(0, 8)}...)`);
  }

  /**
   * Analyze holder distribution and return signals
   */
  async analyzeHolders(mintAddress: string): Promise<{
    distribution: {
      totalHolders: number;
      top10Percentage: number;
      top20Percentage: number;
      whaleCount: number;
      concentration: 'high' | 'medium' | 'low';
    };
    signals: {
      dangerousConcentration: boolean;
      healthyDistribution: boolean;
      whalePresence: boolean;
    };
    score: number;
  } | null> {
    const holderData = await this.getHolderDistribution(mintAddress, 50);

    if (!holderData) {
      return null;
    }

    const { totalHolders, topHolders } = holderData;

    // Calculate concentration metrics
    const top10 = topHolders.slice(0, 10);
    const top20 = topHolders.slice(0, 20);

    const top10Percentage = top10.reduce((sum, h) => sum + h.percentage, 0);
    const top20Percentage = top20.reduce((sum, h) => sum + h.percentage, 0);

    // Count whales (holding > 2% of supply)
    const whaleCount = topHolders.filter(h => h.percentage > 2).length;

    // Determine concentration level
    let concentration: 'high' | 'medium' | 'low' = 'medium';
    if (top10Percentage > 70) concentration = 'high';
    else if (top10Percentage < 40) concentration = 'low';

    // Generate signals
    const signals = {
      dangerousConcentration: top10Percentage > 80 || (topHolders[0]?.percentage || 0) > 30,
      healthyDistribution: top10Percentage < 50 && totalHolders > 100,
      whalePresence: whaleCount >= 3,
    };

    // Calculate holder health score (0-100)
    let score = 50;

    // Penalize high concentration
    if (top10Percentage > 80) score -= 30;
    else if (top10Percentage > 60) score -= 15;
    else if (top10Percentage < 40) score += 15;

    // Reward holder count
    if (totalHolders > 500) score += 15;
    else if (totalHolders > 200) score += 10;
    else if (totalHolders < 50) score -= 15;

    // Moderate whale presence is okay, too many is bad
    if (whaleCount >= 1 && whaleCount <= 5) score += 5;
    else if (whaleCount > 10) score -= 10;

    // Penalize single wallet dominance
    if ((topHolders[0]?.percentage || 0) > 20) score -= 20;

    score = Math.max(0, Math.min(100, score));

    return {
      distribution: {
        totalHolders,
        top10Percentage,
        top20Percentage,
        whaleCount,
        concentration,
      },
      signals,
      score,
    };
  }

  /**
   * Detect holder changes between snapshots
   */
  async detectHolderChanges(mintAddress: string): Promise<{
    newWhales: string[];
    exitedWhales: string[];
    accumulatingAddresses: Array<{ address: string; changePercent: number }>;
    distributingAddresses: Array<{ address: string; changePercent: number }>;
    overallTrend: 'accumulation' | 'distribution' | 'neutral';
  } | null> {
    const currentData = await this.getHolderDistribution(mintAddress, 50);

    if (!currentData) {
      return null;
    }

    const cacheKey = mintAddress;
    const previousSnapshot = this.holderSnapshots.get(cacheKey);
    const now = Date.now();

    // Create current snapshot
    const currentSnapshot = {
      holders: currentData.topHolders,
      timestamp: now,
    };

    // Update cache
    this.holderSnapshots.set(cacheKey, currentSnapshot);

    // If no previous data, can't detect changes
    if (!previousSnapshot || (now - previousSnapshot.timestamp) > this.snapshotTTL * 10) {
      return {
        newWhales: [],
        exitedWhales: [],
        accumulatingAddresses: [],
        distributingAddresses: [],
        overallTrend: 'neutral',
      };
    }

    const previousMap = new Map(previousSnapshot.holders.map(h => [h.address, h]));
    const currentMap = new Map(currentData.topHolders.map(h => [h.address, h]));

    const newWhales: string[] = [];
    const exitedWhales: string[] = [];
    const accumulatingAddresses: Array<{ address: string; changePercent: number }> = [];
    const distributingAddresses: Array<{ address: string; changePercent: number }> = [];

    // Check current holders for changes
    for (const [address, current] of currentMap) {
      const previous = previousMap.get(address);

      if (!previous) {
        // New holder in top list
        if (current.percentage > 2) {
          newWhales.push(address);
        }
      } else {
        // Existing holder - check for accumulation/distribution
        const changePercent = previous.percentage > 0
          ? ((current.percentage - previous.percentage) / previous.percentage) * 100
          : 100;

        if (changePercent > 10) {
          accumulatingAddresses.push({ address, changePercent });
        } else if (changePercent < -10) {
          distributingAddresses.push({ address, changePercent });
        }
      }
    }

    // Check for exited whales
    for (const [address, previous] of previousMap) {
      if (previous.percentage > 2 && !currentMap.has(address)) {
        exitedWhales.push(address);
      }
    }

    // Determine overall trend
    let overallTrend: 'accumulation' | 'distribution' | 'neutral' = 'neutral';
    const accumulationScore = accumulatingAddresses.length + newWhales.length;
    const distributionScore = distributingAddresses.length + exitedWhales.length;

    if (accumulationScore > distributionScore + 2) {
      overallTrend = 'accumulation';
    } else if (distributionScore > accumulationScore + 2) {
      overallTrend = 'distribution';
    }

    return {
      newWhales,
      exitedWhales,
      accumulatingAddresses,
      distributingAddresses,
      overallTrend,
    };
  }

  /**
   * Get recent transactions for a token (for tracking whale movements)
   */
  async getRecentTokenTransactions(mintAddress: string, limit: number = 20): Promise<Array<{
    signature: string;
    timestamp: number;
    from: string;
    to: string;
    amount: number;
    type: 'transfer' | 'swap' | 'other';
  }> | null> {
    if (!this.apiKey) {
      return null;
    }

    return withRetry(async () => {
      const response = await axios.get(
        `${this.baseUrl}/addresses/${mintAddress}/transactions`,
        {
          params: {
            'api-key': this.apiKey,
            limit: limit,
          },
          timeout: API_TIMEOUT,
        }
      );

      const transactions = response.data || [];

      return transactions.map((tx: any) => ({
        signature: tx.signature,
        timestamp: tx.timestamp,
        from: tx.feePayer || tx.source || '',
        to: tx.destination || '',
        amount: tx.tokenTransfers?.[0]?.tokenAmount || 0,
        type: tx.type === 'SWAP' ? 'swap' : tx.type === 'TRANSFER' ? 'transfer' : 'other',
      }));
    }, `Helius.getRecentTokenTransactions(${mintAddress.substring(0, 8)}...)`);
  }
}

export class JupiterClient {
  private baseUrl = 'https://quote-api.jup.ag/v6';

  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 100
  ): Promise<any> {
    return withRetry(async () => {
      const response = await axios.get(`${this.baseUrl}/quote`, {
        params: {
          inputMint,
          outputMint,
          amount,
          slippageBps,
        },
        timeout: API_TIMEOUT,
      });
      return response.data;
    }, 'Jupiter.getQuote');
  }

  async getSwapTransaction(quoteResponse: any, userPublicKey: string): Promise<any> {
    return withRetry(async () => {
      const response = await axios.post(`${this.baseUrl}/swap`, {
        quoteResponse,
        userPublicKey,
        wrapUnwrapSOL: true,
      }, { timeout: API_TIMEOUT });
      return response.data;
    }, 'Jupiter.getSwapTransaction');
  }

  async getTokenPrice(mintAddress: string): Promise<number | null> {
    return withRetry(async () => {
      const response = await axios.get(
        `https://price.jup.ag/v4/price?ids=${mintAddress}`,
        { timeout: API_TIMEOUT }
      );
      const price = response.data.data?.[mintAddress]?.price;
      return price !== undefined ? price : null;
    }, `Jupiter.getTokenPrice(${mintAddress.substring(0, 8)}...)`);
  }
}

export const dexScreener = new DexScreenerClient();
export const birdeye = new BirdeyeClient();
export const helius = new HeliusClient();
export const jupiter = new JupiterClient();

// Re-export enhanced metrics service for convenience
export { enhancedMetrics } from './enhancedMetrics';
