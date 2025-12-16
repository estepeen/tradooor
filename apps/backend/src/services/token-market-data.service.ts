/**
 * Service for fetching token market data (market cap, liquidity, volume)
 * Primary: DexScreener API (free, better coverage for small tokens)
 * Fallback: Birdeye API (if DexScreener doesn't have data)
 */

export interface TokenMarketData {
  price: number | null; // Current price in USD
  marketCap: number | null; // Market cap in USD
  liquidity: number | null; // Liquidity in USD
  volume24h: number | null; // 24h volume in USD
  tokenAgeMinutes: number | null; // Token age in minutes (from creation)
  ageMinutes: number | null; // Alias for tokenAgeMinutes
  holders?: number | null; // Number of holders
  topHolderPercent?: number | null; // Top holder %
  top10HolderPercent?: number | null; // Top 10 holders %
  source?: 'dexscreener' | 'birdeye'; // Data source
}

export class TokenMarketDataService {
  private birdeyeApiKey: string | undefined;
  private cache = new Map<string, { data: TokenMarketData; timestamp: number }>();

  constructor() {
    this.birdeyeApiKey = process.env.BIRDEYE_API_KEY;
  }

  /**
   * Get cache TTL based on market cap (for dynamic intervals)
   */
  private getCacheTTL(marketCap: number | null): number {
    if (!marketCap || marketCap < 300000) return 1 * 60 * 1000;  // 1 min for < 300k (shitcoins)
    if (marketCap < 500000) return 2 * 60 * 1000;                // 2 min for 300k-500k
    if (marketCap < 1000000) return 2 * 60 * 1000;               // 2 min for 500k-1M
    return 5 * 60 * 1000;                                         // 5 min for > 1M
  }

  /**
   * Fetch market data from DexScreener API (primary source)
   */
  private async getMarketDataFromDexScreener(mintAddress: string): Promise<TokenMarketData | null> {
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`;
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) return null;

      const data = await response.json() as any;
      if (!data.pairs || !Array.isArray(data.pairs) || data.pairs.length === 0) {
        return null;
      }

      // Find the best pair (highest liquidity)
      const bestPair = data.pairs.reduce((best: any, pair: any) => {
        const currentLiq = parseFloat(pair.liquidity?.usd || '0');
        const bestLiq = parseFloat(best?.liquidity?.usd || '0');
        return currentLiq > bestLiq ? pair : best;
      }, data.pairs[0]);

      // Extract data
      const price = parseFloat(bestPair.priceUsd || '0') || null;
      const liquidity = parseFloat(bestPair.liquidity?.usd || '0') || null;
      const marketCap = parseFloat(bestPair.fdv || '0') || null; // FDV = Fully Diluted Valuation
      const volume24h = parseFloat(bestPair.volume?.h24 || '0') || null;

      // Calculate token age
      let tokenAgeMinutes: number | null = null;
      if (bestPair.pairCreatedAt) {
        const createdAt = new Date(bestPair.pairCreatedAt);
        const now = new Date();
        tokenAgeMinutes = Math.round((now.getTime() - createdAt.getTime()) / (1000 * 60));
      }

      return {
        price,
        marketCap,
        liquidity,
        volume24h,
        tokenAgeMinutes,
        ageMinutes: tokenAgeMinutes,
        source: 'dexscreener',
      };
    } catch (error: any) {
      console.warn(`⚠️  DexScreener error for ${mintAddress.substring(0, 8)}...: ${error.message}`);
      return null;
    }
  }

  /**
   * Get market data for a token
   * Primary: DexScreener (free, better for small tokens)
   * Fallback: Birdeye (if DexScreener doesn't have data)
   */
  async getMarketData(mintAddress: string, timestamp?: Date): Promise<TokenMarketData> {
    // Check cache first
    const cacheKey = `${mintAddress}-${timestamp?.getTime() || 'current'}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      const cacheTTL = this.getCacheTTL(cached.data.marketCap);
      if (Date.now() - cached.timestamp < cacheTTL) {
      return cached.data;
    }
    }

    // 1. Try DexScreener first (free, better coverage)
    const dexData = await this.getMarketDataFromDexScreener(mintAddress);
    if (dexData && dexData.price) {
      this.cache.set(cacheKey, { data: dexData, timestamp: Date.now() });
      return dexData;
    }

    // 2. Fallback to Birdeye if DexScreener doesn't have data

    if (!this.birdeyeApiKey) {
      console.warn(`⚠️  No data from DexScreener and BIRDEYE_API_KEY not set for ${mintAddress.substring(0, 8)}...`);
      return {
        price: null,
        marketCap: null,
        liquidity: null,
        volume24h: null,
        tokenAgeMinutes: null,
        ageMinutes: null,
        source: undefined,
      };
    }

    try {
      // Birdeye API fallback: /defi/token_overview?address={address}
      const url = `https://public-api.birdeye.so/defi/token_overview?address=${mintAddress}`;
      
      const response = await fetch(url, {
        headers: {
          'X-API-KEY': this.birdeyeApiKey,
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          console.warn('⚠️  Birdeye API key is invalid or missing');
        } else if (response.status === 404) {
          console.warn(`⚠️  Token not found in Birdeye: ${mintAddress.substring(0, 8)}...`);
        } else {
          const errorText = await response.text();
          console.warn(`⚠️  Birdeye API error (${response.status}): ${errorText.substring(0, 200)}`);
        }
        return {
          price: null,
          marketCap: null,
          liquidity: null,
          volume24h: null,
          tokenAgeMinutes: null,
          ageMinutes: null,
          source: undefined,
        };
      }

      const data = await response.json();
      const responseData = data as any;

      if (!responseData.success || !responseData.data) {
        console.warn(`⚠️  Birdeye API returned success=false: ${responseData.message || 'Unknown error'}`);
        return {
          price: null,
          marketCap: null,
          liquidity: null,
          volume24h: null,
          tokenAgeMinutes: null,
          ageMinutes: null,
          source: undefined,
        };
      }

      const overview = responseData.data;
      
      // Extract market data from Birdeye response
      // Birdeye token_overview returns: { marketcap, liquidity, volume_24h_usd, ... }
      // Note: Birdeye uses snake_case for field names
      const marketCap = overview.marketcap !== undefined ? Number(overview.marketcap) : 
                       (overview.marketCap !== undefined ? Number(overview.marketCap) : null);
      const liquidity = overview.liquidity !== undefined ? Number(overview.liquidity) : null;
      const volume24h = overview.volume_24h_usd !== undefined ? Number(overview.volume_24h_usd) :
                        (overview.volume24h !== undefined ? Number(overview.volume24h) : null);
      
      // Calculate token age (if we have creation timestamp)
      let tokenAgeMinutes: number | null = null;
      if (overview.createdAt || overview.firstSeenAt || overview.created_at || overview.first_seen_at) {
        const createdAt = overview.createdAt || overview.firstSeenAt || overview.created_at || overview.first_seen_at;
        // Birdeye might return Unix timestamp (seconds) or ISO string
        const createdAtDate = typeof createdAt === 'number' 
          ? new Date(createdAt * 1000) // Unix timestamp in seconds
          : new Date(createdAt); // ISO string
        const now = timestamp || new Date();
        tokenAgeMinutes = Math.round((now.getTime() - createdAtDate.getTime()) / (1000 * 60));
      }

      // Get price from overview
      const price = overview.price !== undefined ? Number(overview.price) :
                    (overview.v24hUSD !== undefined && overview.supply !== undefined 
                      ? Number(overview.v24hUSD) / Number(overview.supply) 
                      : null);

      const result: TokenMarketData = {
        price,
        marketCap,
        liquidity,
        volume24h,
        tokenAgeMinutes,
        ageMinutes: tokenAgeMinutes,
        holders: overview.holder || overview.holders || null,
        source: 'birdeye',
      };

      // Cache the result
      this.cache.set(cacheKey, { data: result, timestamp: Date.now() });

      return result;
    } catch (error: any) {
      console.warn(`⚠️  Error fetching market data for ${mintAddress.substring(0, 8)}...: ${error.message}`);
      return {
        price: null,
        marketCap: null,
        liquidity: null,
        volume24h: null,
        tokenAgeMinutes: null,
        ageMinutes: null,
        source: undefined,
      };
    }
  }

  /**
   * Get market data for multiple tokens (batch)
   * Note: Birdeye doesn't have a batch endpoint, so we call individually with rate limiting
   */
  async getMarketDataBatch(mintAddresses: string[], timestamp?: Date): Promise<Map<string, TokenMarketData>> {
    const result = new Map<string, TokenMarketData>();
    
    // Process in smaller batches to avoid rate limits
    const BATCH_SIZE = 10;
    for (let i = 0; i < mintAddresses.length; i += BATCH_SIZE) {
      const batch = mintAddresses.slice(i, i + BATCH_SIZE);
      const promises = batch.map(async (mintAddress) => {
        const data = await this.getMarketData(mintAddress, timestamp);
        return { mintAddress, data };
      });

      const batchResults = await Promise.all(promises);
      batchResults.forEach(({ mintAddress, data }) => {
        result.set(mintAddress.toLowerCase(), data);
      });

      // Small delay between batches to respect rate limits
      if (i + BATCH_SIZE < mintAddresses.length) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
      }
    }

    return result;
  }
}
