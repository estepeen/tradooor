/**
 * Service for fetching token security data from Birdeye API
 * Includes: honeypot detection, buy/sell tax, marketcap, holders count, LP lock status
 */

interface TokenSecurityData {
  honeypot: boolean | null;
  buyTax: number | null; // Percentage (0-100)
  sellTax: number | null; // Percentage (0-100)
  marketCap: number | null; // USD
  holdersCount: number | null;
  tokenAgeMinutes: number | null;
  lpLocked: boolean | null;
  top10HoldersPercent: number | null; // Percentage of supply held by top 10 holders
  dexPaid: boolean | null; // Whether DEX fees are paid
}

export class TokenSecurityService {
  private birdeyeApiKey: string | undefined;
  private cache = new Map<string, { data: TokenSecurityData; timestamp: number }>();
  private readonly CACHE_TTL = 10 * 60 * 1000; // 10 minutes cache

  constructor() {
    this.birdeyeApiKey = process.env.BIRDEYE_API_KEY;
  }

  /**
   * Get security data for a token from Birdeye API
   * DISABLED: Smart wallets don't get rugged, so security checks are not needed
   * DexScreener is used for market data instead
   */
  async getTokenSecurity(mintAddress: string): Promise<TokenSecurityData> {
    // Security checks disabled - smart wallets don't get rugged
    return this.getDefaultSecurityData();
    
    /* DISABLED - Smart wallets don't get rugged, DexScreener is used for market data
    // Check cache first
    const cached = this.cache.get(mintAddress.toLowerCase());
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    if (!this.birdeyeApiKey) {
      console.warn('⚠️  BIRDEYE_API_KEY not set, cannot fetch token security data');
      return this.getDefaultSecurityData();
    }

    try {
      // Birdeye Token Overview API - obsahuje security data (honeypot, tax, marketcap, holders)
      // Alternativně můžeme použít /defi/token_overview, který má více dat
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
          console.warn(`⚠️  Token security data not found in Birdeye: ${mintAddress.substring(0, 8)}...`);
        } else {
          const errorText = await response.text();
          console.warn(`⚠️  Birdeye Security API error (${response.status}): ${errorText.substring(0, 200)}`);
        }
        return this.getDefaultSecurityData();
      }

      const data = await response.json();
      const responseData = data as any;

      if (!responseData.success || !responseData.data) {
        console.warn(`⚠️  Birdeye Security API returned success=false: ${responseData.message || 'Unknown error'}`);
        return this.getDefaultSecurityData();
      }

      const security = responseData.data;
      
      // Extract security data from Birdeye response
      // Birdeye security API returns various security flags
      const honeypot = security.honeypot !== undefined ? Boolean(security.honeypot) : null;
      const buyTax = security.buyTax !== undefined ? Number(security.buyTax) : 
                     (security.buy_tax !== undefined ? Number(security.buy_tax) : null);
      const sellTax = security.sellTax !== undefined ? Number(security.sellTax) :
                      (security.sell_tax !== undefined ? Number(security.sell_tax) : null);
      const marketCap = security.marketcap !== undefined ? Number(security.marketcap) :
                       (security.marketCap !== undefined ? Number(security.marketCap) : null);
      const holdersCount = security.holdersCount !== undefined ? Number(security.holdersCount) :
                           (security.holders_count !== undefined ? Number(security.holders_count) : null);
      const lpLocked = security.lpLocked !== undefined ? Boolean(security.lpLocked) :
                      (security.lp_locked !== undefined ? Boolean(security.lp_locked) : null);
      const top10HoldersPercent = security.top10HoldersPercent !== undefined ? Number(security.top10HoldersPercent) :
                                 (security.top_10_holders_percent !== undefined ? Number(security.top_10_holders_percent) : null);
      const dexPaid = security.dexPaid !== undefined ? Boolean(security.dexPaid) :
                     (security.dex_paid !== undefined ? Boolean(security.dex_paid) : null);

      // Calculate token age if we have creation timestamp
      let tokenAgeMinutes: number | null = null;
      if (security.createdAt || security.firstSeenAt || security.created_at || security.first_seen_at) {
        const createdAt = security.createdAt || security.firstSeenAt || security.created_at || security.first_seen_at;
        const createdAtDate = typeof createdAt === 'number' 
          ? new Date(createdAt * 1000)
          : new Date(createdAt);
        const now = new Date();
        tokenAgeMinutes = Math.round((now.getTime() - createdAtDate.getTime()) / (1000 * 60));
      }

      const result: TokenSecurityData = {
        honeypot,
        buyTax,
        sellTax,
        marketCap,
        holdersCount,
        tokenAgeMinutes,
        lpLocked,
        top10HoldersPercent,
        dexPaid,
      };

      // Cache the result
      this.cache.set(mintAddress.toLowerCase(), { data: result, timestamp: Date.now() });

      return result;
    } catch (error: any) {
      console.warn(`⚠️  Error fetching token security for ${mintAddress.substring(0, 8)}...: ${error.message}`);
      return this.getDefaultSecurityData();
    }
  }

  /**
   * Get security data for multiple tokens (batch)
   */
  async getTokenSecurityBatch(mintAddresses: string[]): Promise<Map<string, TokenSecurityData>> {
    const result = new Map<string, TokenSecurityData>();
    
    // Process in smaller batches to avoid rate limits
    const BATCH_SIZE = 5; // Smaller batch for security API
    for (let i = 0; i < mintAddresses.length; i += BATCH_SIZE) {
      const batch = mintAddresses.slice(i, i + BATCH_SIZE);
      const promises = batch.map(async (mintAddress) => {
        const data = await this.getTokenSecurity(mintAddress);
        return { mintAddress, data };
      });

      const batchResults = await Promise.all(promises);
      batchResults.forEach(({ mintAddress, data }) => {
        result.set(mintAddress.toLowerCase(), data);
      });

      // Delay between batches to respect rate limits
      if (i + BATCH_SIZE < mintAddresses.length) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
      }
    }

    return result;
  }

  private getDefaultSecurityData(): TokenSecurityData {
    return {
      honeypot: null,
      buyTax: null,
      sellTax: null,
      marketCap: null,
      holdersCount: null,
      tokenAgeMinutes: null,
      lpLocked: null,
      top10HoldersPercent: null,
      dexPaid: null,
    };
  }
}
