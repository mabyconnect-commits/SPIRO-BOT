import axios from 'axios';
import { config } from '../config';
import logger from '../utils/logger';
import { TokenData } from '../types';

export class DexScreenerClient {
  private baseUrl = 'https://api.dexscreener.com/latest/dex';

  async getTokenData(contractAddress: string): Promise<any> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/tokens/${contractAddress}`
      );
      return response.data.pairs?.[0] || null;
    } catch (error) {
      logger.error(`DexScreener API error for ${contractAddress}:`, error);
      return null;
    }
  }

  async searchPairs(query: string): Promise<any[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/search?q=${query}`);
      return response.data.pairs || [];
    } catch (error) {
      logger.error(`DexScreener search error:`, error);
      return [];
    }
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

    try {
      const response = await axios.get(
        `${this.baseUrl}/defi/token_overview`,
        {
          params: { address: contractAddress },
          headers: { 'X-API-KEY': this.apiKey },
        }
      );
      return response.data.data;
    } catch (error) {
      logger.error(`Birdeye API error:`, error);
      return null;
    }
  }

  async getTokenSecurity(contractAddress: string): Promise<any> {
    if (!this.apiKey) return null;

    try {
      const response = await axios.get(
        `${this.baseUrl}/defi/token_security`,
        {
          params: { address: contractAddress },
          headers: { 'X-API-KEY': this.apiKey },
        }
      );
      return response.data.data;
    } catch (error) {
      logger.error(`Birdeye security check error:`, error);
      return null;
    }
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

    try {
      const response = await axios.post(
        `${this.baseUrl}/token-metadata`,
        {
          mintAccounts: [mintAddress],
        },
        {
          params: { 'api-key': this.apiKey },
        }
      );
      return response.data[0];
    } catch (error) {
      logger.error(`Helius API error:`, error);
      return null;
    }
  }

  async getTokenHolders(mintAddress: string): Promise<number> {
    if (!this.apiKey) return 0;

    try {
      const response = await axios.get(
        `${this.baseUrl}/addresses/${mintAddress}/holders`,
        {
          params: { 'api-key': this.apiKey },
        }
      );
      return response.data.total || 0;
    } catch (error) {
      logger.error(`Helius holders error:`, error);
      return 0;
    }
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
    try {
      const response = await axios.get(`${this.baseUrl}/quote`, {
        params: {
          inputMint,
          outputMint,
          amount,
          slippageBps,
        },
      });
      return response.data;
    } catch (error) {
      logger.error(`Jupiter quote error:`, error);
      return null;
    }
  }

  async getSwapTransaction(quoteResponse: any, userPublicKey: string): Promise<any> {
    try {
      const response = await axios.post(`${this.baseUrl}/swap`, {
        quoteResponse,
        userPublicKey,
        wrapUnwrapSOL: true,
      });
      return response.data;
    } catch (error) {
      logger.error(`Jupiter swap error:`, error);
      return null;
    }
  }

  async getTokenPrice(mintAddress: string): Promise<number> {
    try {
      const response = await axios.get(
        `https://price.jup.ag/v4/price?ids=${mintAddress}`
      );
      return response.data.data?.[mintAddress]?.price || 0;
    } catch (error) {
      logger.error(`Jupiter price error:`, error);
      return 0;
    }
  }
}

export const dexScreener = new DexScreenerClient();
export const birdeye = new BirdeyeClient();
export const helius = new HeliusClient();
export const jupiter = new JupiterClient();
