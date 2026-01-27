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
   * Get new pairs from specific DEXs (launchpads)
   */
  async getNewPairs(): Promise<any[]> {
    const result = await withRetry(async () => {
      const response = await axios.get(
        `${this.baseUrl}/pairs/solana`,
        { timeout: API_TIMEOUT }
      );
      return response.data.pairs || [];
    }, 'DexScreener.getNewPairs');

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
  private apiKey = config.apis.helius;

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
