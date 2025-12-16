/**
 * Service for fetching token market data (market cap, liquidity, volume) from Birdeye API
 * Used for tracking market conditions at entry/exit for copytrading analysis
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
}

export class TokenMarketDataService {
  private birdeyeApiKey: string | undefined;
  private cache = new Map<string, { data: TokenMarketData; timestamp: number }>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache

  constructor() {
    this.birdeyeApiKey = process.env.BIRDEYE_API_KEY;
  }

  /**
   * Get market data for a token at a specific timestamp
   * Uses Birdeye API to fetch current market data
   * Note: Birdeye doesn't provide historical market data easily, so we use current data as approximation
   */
  async getMarketData(mintAddress: string, timestamp?: Date): Promise<TokenMarketData> {
    // Check cache first
    const cacheKey = `${mintAddress}-${timestamp?.getTime() || 'current'}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    if (!this.birdeyeApiKey) {
      console.warn('⚠️  BIRDEYE_API_KEY not set, cannot fetch market data');
      return {
        price: null,
        marketCap: null,
        liquidity: null,
        volume24h: null,
        tokenAgeMinutes: null,
        ageMinutes: null,
      };
    }

    try {
      // Birdeye API: /defi/token_overview?address={address}
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
