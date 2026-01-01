/**
 * Service for fetching token market data (market cap, liquidity, volume)
 *
 * Strategy for pump.fun tokens (detected by programId or mint suffix):
 * 1. Calculate MCap from bonding curve: pricePerToken * 1B (instant, no API)
 * 2. Fallback to Birdeye if bonding curve data not available
 *
 * Strategy for other tokens:
 * 1. Birdeye API (reliable, has rate limits)
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
  source?: 'bonding_curve' | 'birdeye'; // Data source

  // Volume metrics (from DexScreener txns)
  buys5m?: number | null;    // Number of buy transactions in 5 minutes
  sells5m?: number | null;   // Number of sell transactions in 5 minutes
  buyVolume5m?: number | null;  // Buy volume in USD (5 minutes)
  sellVolume5m?: number | null; // Sell volume in USD (5 minutes)
  buySellRatio5m?: number | null; // Buy/Sell volume ratio (>1 = more buying)

  // Price change metrics
  priceChange5m?: number | null;  // Price change % in 5 minutes
  priceChange1h?: number | null;  // Price change % in 1 hour
  priceChange6h?: number | null;  // Price change % in 6 hours
  priceChange24h?: number | null; // Price change % in 24 hours
}

// Pump.fun constants
const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_FUN_TOTAL_SUPPLY = 1_000_000_000; // 1 billion tokens

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
   * Get market data for a token
   * For pump.fun tokens: Calculate from bonding curve (instant)
   * For other tokens: Use Birdeye API
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

    // Use Birdeye for all tokens (works for both pump.fun and other tokens)
    if (!this.birdeyeApiKey) {
      console.warn(`⚠️  BIRDEYE_API_KEY not set for ${mintAddress.substring(0, 8)}...`);
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

  /**
   * Get market data with trade meta as primary source (for bonding curve MCap)
   *
   * PRIORITY:
   * 1. Trade meta (bonding curve calculation - instant, no API)
   * 2. Birdeye API (fallback for non-pump.fun tokens)
   *
   * @param mintAddress - Token mint address
   * @param tradeMeta - Optional trade meta object containing marketCapUsd or fdvUsd
   * @returns TokenMarketData with MCap from trade meta or API
   */
  async getMarketDataWithTradeMeta(
    mintAddress: string,
    tradeMeta?: { marketCapUsd?: number; fdvUsd?: number; liquidity?: number } | null
  ): Promise<TokenMarketData> {
    // 1. PRIMÁRNĚ: Použij MCap z trade meta (bonding curve - okamžité, žádné API)
    if (tradeMeta?.marketCapUsd || tradeMeta?.fdvUsd) {
      const marketCap = tradeMeta.marketCapUsd || tradeMeta.fdvUsd || null;
      return {
        price: null,
        marketCap: marketCap,
        liquidity: tradeMeta.liquidity || null,
        volume24h: null,
        tokenAgeMinutes: null,
        ageMinutes: null,
        source: 'bonding_curve',
      };
    }

    // 2. FALLBACK: Birdeye API
    return this.getMarketData(mintAddress);
  }

  /**
   * Calculate market cap from bonding curve price for pump.fun tokens
   * Formula: pricePerTokenUsd * PUMP_FUN_TOTAL_SUPPLY (1B)
   *
   * @param pricePerTokenSol - Price per token in SOL (from trade data)
   * @param solPriceUsd - Current SOL price in USD
   * @returns Market cap in USD
   */
  static calculatePumpFunMarketCap(pricePerTokenSol: number, solPriceUsd: number): number {
    const pricePerTokenUsd = pricePerTokenSol * solPriceUsd;
    return pricePerTokenUsd * PUMP_FUN_TOTAL_SUPPLY;
  }

  /**
   * Check if a token is a pump.fun token based on program ID or mint address
   * Pump.fun mints often end with "pump" suffix
   */
  static isPumpFunToken(programId?: string, mintAddress?: string): boolean {
    if (programId === PUMP_FUN_PROGRAM_ID) return true;
    if (mintAddress && mintAddress.toLowerCase().endsWith('pump')) return true;
    return false;
  }
}

// Export constants for use in other modules
export { PUMP_FUN_PROGRAM_ID, PUMP_FUN_TOTAL_SUPPLY };
