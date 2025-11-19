/**
 * Service for fetching current token prices from external APIs
 * Primary: DexScreener API (free, batch endpoint, no API key needed, better rate limits)
 * Fallback: Birdeye API (requires API key, more accurate for some tokens)
 */

interface TokenPrice {
  priceUsd: number;
  timestamp: number;
}

/**
 * Rate limiter pro Birdeye API
 * Respektuje rate limits podle tieru (Standard: 1 rps, Starter: 15 rps, Premium: 50 rps, Business: 100 rps)
 */
class BirdeyeRateLimiter {
  private lastCallTime = 0;
  private minTimeMs: number;
  private queue: Array<() => void> = [];
  private running = false;

  constructor(requestsPerSecond: number = 1) {
    // Bezpečná hodnota: pokud není specifikováno, použij 1 rps (Standard tier)
    // Přidáme malou rezervu (10%) pro jistotu, že nepřekročíme limit
    this.minTimeMs = Math.ceil((1000 / requestsPerSecond) * 1.1);
    console.log(`   🕐 Birdeye rate limiter initialized: ${requestsPerSecond} rps (min delay: ${this.minTimeMs}ms)`);
  }

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const run = async () => {
        // Počkej na minTime od posledního volání
        const now = Date.now();
        const timeSinceLastCall = now - this.lastCallTime;
        
        // Pokud je to první volání (lastCallTime === 0), nečekej
        // Jinak počkej, pokud uplynulo méně než minTimeMs
        if (this.lastCallTime > 0 && timeSinceLastCall < this.minTimeMs) {
          const waitTime = this.minTimeMs - timeSinceLastCall;
          console.log(`   ⏳ Rate limiter: waiting ${waitTime}ms before next request...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        this.lastCallTime = Date.now();

        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          // Spusť další z fronty
          if (this.queue.length > 0) {
            const next = this.queue.shift()!;
            next();
          } else {
            this.running = false;
          }
        }
      };

      // Pokud není žádný request v běhu, spusť hned, jinak přidej do fronty
      if (!this.running) {
        this.running = true;
        run();
      } else {
        this.queue.push(run);
      }
    });
  }
}

export class TokenPriceService {
  private priceCache = new Map<string, { price: TokenPrice; timestamp: number }>();
  private historicalPriceCache = new Map<string, { price: number; timestamp: number }>(); // Cache pro historické ceny
  private readonly CACHE_TTL = 30 * 60 * 1000; // 30 minutes
  private readonly HISTORICAL_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours (historické ceny se nemění)
  private birdeyeApiKey: string | undefined;
  private birdeyeRateLimiter: BirdeyeRateLimiter;

  constructor() {
    this.birdeyeApiKey = process.env.BIRDEYE_API_KEY;
    
    // Rate limiter pro Birdeye API
    // Default: 1 rps (Standard tier), můžeš změnit přes env variable
    // Starter: 15 rps, Premium: 50 rps, Business: 100 rps
    const birdeyeRps = parseInt(process.env.BIRDEYE_RPS || '1');
    const tierName = birdeyeRps === 1 ? 'Standard' : birdeyeRps >= 15 ? 'Starter+' : birdeyeRps >= 50 ? 'Premium+' : 'Standard';
    console.log(`📊 Birdeye API rate limit: ${birdeyeRps} requests/second (${tierName} tier)`);
    this.birdeyeRateLimiter = new BirdeyeRateLimiter(birdeyeRps);
  }

  /**
   * Fetch prices from DexScreener API (free, no API key needed!)
   * DexScreener API: https://api.dexscreener.com/latest/dex/tokens/TOKEN
   * Note: DexScreener doesn't support batch, so we call individually with rate limiting
   */
  private async fetchPricesFromDexScreener(mintAddresses: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    
    if (mintAddresses.length === 0) {
      return result;
    }

    // Process in batches to avoid overwhelming the API
    const BATCH_SIZE = 10;
    const DELAY_MS = 200; // 200ms delay between requests (5 requests per second)
    
    for (let i = 0; i < mintAddresses.length; i += BATCH_SIZE) {
      const batch = mintAddresses.slice(i, i + BATCH_SIZE);
      
      // Process batch in parallel (but with delay between batches)
      const promises = batch.map(async (mintAddress) => {
        try {
          const url = `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`;
          const response = await fetch(url, {
            headers: {
              'Accept': 'application/json',
            },
          });

          if (!response.ok) {
            return { mintAddress, price: null };
          }

          const data = await response.json() as any;
          if (data.pairs && Array.isArray(data.pairs) && data.pairs.length > 0) {
            // Find the best price (highest liquidity or most recent)
            let bestPrice = 0;
            for (const pair of data.pairs) {
              const priceUsd = parseFloat(pair.priceUsd || '0');
              if (priceUsd > 0 && priceUsd > bestPrice) {
                bestPrice = priceUsd;
              }
            }
            if (bestPrice > 0) {
              return { mintAddress, price: bestPrice };
            }
          }
          return { mintAddress, price: null };
        } catch (error: any) {
          return { mintAddress, price: null };
        }
      });

      const results = await Promise.all(promises);
      for (const { mintAddress, price } of results) {
        if (price !== null) {
          result.set(mintAddress.toLowerCase(), price);
        }
      }

      // Delay between batches
      if (i + BATCH_SIZE < mintAddresses.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      }
    }

    return result;
  }

  /**
   * Get current price for a single token from Birdeye
   */
  async getTokenPrice(mintAddress: string): Promise<number | null> {
    if (!this.birdeyeApiKey) {
      console.warn('⚠️  BIRDEYE_API_KEY not set, cannot fetch token prices');
      return null;
    }

    try {
      // Check cache first
      const cached = this.priceCache.get(mintAddress.toLowerCase());
      const now = Date.now();
      
      if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
        return cached.price.priceUsd;
      }

      const url = `https://public-api.birdeye.so/defi/price?address=${mintAddress}&ui_amount_mode=raw`;
      
      // Použij rate limiter pro Birdeye API
      const response = await this.birdeyeRateLimiter.schedule(() =>
        fetch(url, {
          headers: {
            'Accept': 'application/json',
            'X-API-KEY': this.birdeyeApiKey!,
            'x-chain': 'solana',
          },
        })
      );

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          console.warn('⚠️  Birdeye API key is invalid or missing');
        } else if (response.status === 404) {
          console.warn(`⚠️  Token not found in Birdeye: ${mintAddress.substring(0, 8)}...`);
        } else {
          const errorText = await response.text();
          console.warn(`⚠️  Birdeye API error (${response.status}): ${errorText.substring(0, 200)}`);
        }
        return null;
      }

      const data = await response.json() as any;
      
      // Debug logging pro PUMP token
      if (mintAddress.toLowerCase().includes('pump')) {
        console.log(`   🔍 PUMP token API response:`, JSON.stringify(data).substring(0, 300));
      }
      
      if (data.success && data.data && data.data.value !== undefined) {
        const priceUsd = parseFloat(data.data.value);
        
        if (priceUsd > 0) {
          // Update cache
          this.priceCache.set(mintAddress.toLowerCase(), {
            price: { priceUsd, timestamp: now },
            timestamp: now,
          });
          
          return priceUsd;
        } else {
          console.warn(`   ⚠️  Token price is 0 or negative: ${mintAddress.substring(0, 8)}...`);
        }
      } else {
        // Log detailnější chybu
        if (!data.success) {
          console.warn(`   ⚠️  Birdeye API returned success=false: ${data.message || 'Unknown error'}`);
        } else if (!data.data) {
          console.warn(`   ⚠️  Birdeye API returned no data for token: ${mintAddress.substring(0, 8)}...`);
        } else if (data.data.value === undefined) {
          console.warn(`   ⚠️  Birdeye API returned data without value field for token: ${mintAddress.substring(0, 8)}...`);
        }
      }

      return null;
    } catch (error: any) {
      console.warn(`⚠️  Error fetching token price for ${mintAddress}:`, error.message);
      return null;
    }
  }

  /**
   * Get historical price for a token at a specific timestamp from Birdeye
   * Birdeye API: /defi/price_history?address={address}&address_type=token&type=1D&time_from={timestamp}&time_to={timestamp}
   * 
   * @param mintAddress Token mint address
   * @param timestamp Unix timestamp in seconds
   * @returns Price in USD at that timestamp, or null if not available
   */
  async getTokenPriceAtDate(mintAddress: string, timestamp: Date | number): Promise<number | null> {
    if (!this.birdeyeApiKey) {
      console.warn('⚠️  BIRDEYE_API_KEY not set, cannot fetch historical token prices');
      return null;
    }

    try {
      // Convert to Unix timestamp in seconds
      const unixTimestamp = timestamp instanceof Date ? Math.floor(timestamp.getTime() / 1000) : timestamp;
      
      // Check cache first (historické ceny se nemění, můžeme je cachovat dlouho)
      const cacheKey = `${mintAddress.toLowerCase()}_${unixTimestamp}`;
      const cached = this.historicalPriceCache.get(cacheKey);
      const now = Date.now();
      
      if (cached && (now - cached.timestamp) < this.HISTORICAL_CACHE_TTL) {
        console.log(`   ✅ Using cached historical price for ${mintAddress.substring(0, 8)}... at ${new Date(unixTimestamp * 1000).toISOString()}`);
        return cached.price;
      }
      
      // Birdeye historické ceny - Standard tier má přístup k:
      // - /defi/history_price
      // - /defi/historical_price_unix (ONLY Solana)
      // - /defi/ohlcv
      // Zkusíme nejdřív /defi/historical_price_unix (je dostupný pro Standard tier a je specifický pro Solana)
      
      // Endpoint 1: /defi/historical_price_unix (dostupný pro Standard tier, ONLY Solana)
      const historicalPriceUnixUrl = `https://public-api.birdeye.so/defi/historical_price_unix?address=${mintAddress}&unix_time=${unixTimestamp}`;
      
      console.log(`   📡 Fetching historical price from Birdeye (historical_price_unix endpoint): ${historicalPriceUnixUrl}`);
      
      // Použij rate limiter pro Birdeye API
      let response = await this.birdeyeRateLimiter.schedule(() =>
        fetch(historicalPriceUnixUrl, {
          headers: {
            'Accept': 'application/json',
            'X-API-KEY': this.birdeyeApiKey!,
            'x-chain': 'solana',
          },
        })
      );
      
      // Pokud historical_price_unix nefunguje (401/404), zkusíme OHLCV jako fallback
      if (!response.ok && (response.status === 401 || response.status === 404)) {
        console.log(`   ⚠️  historical_price_unix endpoint returned ${response.status}, trying OHLCV endpoint...`);
        const ohlcvUrl = `https://public-api.birdeye.so/defi/ohlcv?address=${mintAddress}&address_type=token&type=1D&time_from=${unixTimestamp}&time_to=${unixTimestamp}`;
        response = await this.birdeyeRateLimiter.schedule(() =>
          fetch(ohlcvUrl, {
            headers: {
              'Accept': 'application/json',
              'X-API-KEY': this.birdeyeApiKey!,
              'x-chain': 'solana',
            },
          })
        );
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.log(`   ⚠️  Birdeye API error (${response.status}): ${errorText.substring(0, 200)}`);
        if (response.status === 401 || response.status === 403) {
          console.warn('⚠️  Birdeye API key is invalid or missing');
          return null;
        } else if (response.status === 429) {
          // Rate limited - wait and retry once
          console.warn(`   ⚠️  Rate limited, waiting 2 seconds and retrying...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          // Retry once (s rate limiterem) - použij stejný URL jako původní request
          const retryUrl = response.url || historicalPriceUnixUrl; // Fallback na historicalPriceUnixUrl pokud response.url není dostupný
          const retryResponse = await this.birdeyeRateLimiter.schedule(() =>
            fetch(retryUrl, {
              headers: {
                'Accept': 'application/json',
                'X-API-KEY': this.birdeyeApiKey!,
                'x-chain': 'solana',
              },
            })
          );
          if (retryResponse.ok) {
            const retryData = await retryResponse.json() as any;
            console.log(`   📊 Birdeye API retry response:`, JSON.stringify(retryData).substring(0, 500));
            
            // historical_price_unix format: { success: true, data: { value: ... } }
            if (retryData.success && retryData.data && retryData.data.value !== undefined) {
              const priceUsd = parseFloat(retryData.data.value);
              if (priceUsd > 0) {
                // Ulož do cache
                this.historicalPriceCache.set(cacheKey, {
                  price: priceUsd,
                  timestamp: now,
                });
                return priceUsd;
              }
            }
            
            // OHLCV/price_history format: { success: true, data: { items: [...] } }
            if (retryData.success && retryData.data && retryData.data.items && Array.isArray(retryData.data.items) && retryData.data.items.length > 0) {
              const priceItem = retryData.data.items[0];
              const priceValue = priceItem.close !== undefined ? priceItem.close : priceItem.value;
              if (priceValue !== undefined) {
                const priceUsd = parseFloat(priceValue);
                if (priceUsd > 0) {
                  // Ulož do cache
                  this.historicalPriceCache.set(cacheKey, {
                    price: priceUsd,
                    timestamp: now,
                  });
                  return priceUsd;
                }
              }
            }
          }
          // If retry failed, return null - caller should use SOL price as fallback
          console.warn(`   ⚠️  Retry failed, returning null - caller should use SOL price at date as fallback`);
          return null;
        } else if (response.status === 404) {
          // Token might not have historical data for that date
          console.warn(`⚠️  No historical price data for ${mintAddress.substring(0, 8)}... at ${new Date(unixTimestamp * 1000).toISOString()} - returning null, caller should use SOL price`);
          // Return null - caller should use SOL price at that date as fallback
          return null;
        }
        return null;
      }

      const data = await response.json() as any;
      console.log(`   📊 Birdeye API response:`, JSON.stringify(data).substring(0, 500));
      
      // Birdeye historical_price_unix returns: { success: true, data: { value: ... } }
      // Birdeye OHLCV returns: { success: true, data: { items: [{ unixTime: ..., close: ... }] } }
      // Birdeye price_history returns: { success: true, data: { items: [{ unixTime: ..., value: ... }] } }
      
      // Zkontroluj, jestli je to historical_price_unix format (přímá hodnota)
      if (data.success && data.data && data.data.value !== undefined) {
        const priceUsd = parseFloat(data.data.value);
        if (priceUsd > 0) {
          // Ulož do cache
          this.historicalPriceCache.set(cacheKey, {
            price: priceUsd,
            timestamp: now,
          });
          return priceUsd;
        }
      }
      
      // Jinak zkus OHLCV/price_history format (items array)
      if (data.success && data.data && data.data.items && Array.isArray(data.data.items) && data.data.items.length > 0) {
        // Get the closest price (first item should be closest to our timestamp)
        const priceItem = data.data.items[0];
        // OHLCV uses 'close' field, price_history uses 'value' field
        const priceValue = priceItem.close !== undefined ? priceItem.close : priceItem.value;
        if (priceValue !== undefined) {
          const priceUsd = parseFloat(priceValue);
          if (priceUsd > 0) {
            // Ulož do cache
            this.historicalPriceCache.set(cacheKey, {
              price: priceUsd,
              timestamp: now,
            });
            return priceUsd;
          }
        }
      }
      
      // Pokud price_history nevrátil data, už jsme zkusili OHLCV výše, takže můžeme přejít na fallback

      // If no historical data, return null - caller should use SOL price at that date as fallback
      console.warn(`⚠️  No historical price data for ${mintAddress.substring(0, 8)}... at ${new Date(unixTimestamp * 1000).toISOString()} - returning null, caller should use SOL price`);
      return null;
    } catch (error: any) {
      console.warn(`⚠️  Error fetching historical token price for ${mintAddress}:`, error.message);
      // Return null - caller should use SOL price at that date as fallback
      return null;
    }
  }

  /**
   * Get current prices for multiple tokens (batch)
   * Uses Jupiter API as primary source (batch endpoint, free, better rate limits)
   * Falls back to Birdeye API for tokens not found in Jupiter
   */
  async getTokenPricesBatch(mintAddresses: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const addressesToFetch: string[] = [];
    const now = Date.now();

    // Check cache first
    for (const mintAddress of mintAddresses) {
      const cached = this.priceCache.get(mintAddress.toLowerCase());
      if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
        result.set(mintAddress.toLowerCase(), cached.price.priceUsd);
      } else {
        addressesToFetch.push(mintAddress);
      }
    }

    if (addressesToFetch.length === 0) {
      return result;
    }

    console.log(`📡 Fetching prices for ${addressesToFetch.length} tokens from DexScreener API (batch)...`);

    // Step 1: Try DexScreener API first (batch endpoint - free, no API key needed!)
    const dexscreenerPrices = await this.fetchPricesFromDexScreener(addressesToFetch);
    console.log(`   ✅ DexScreener API: Got prices for ${dexscreenerPrices.size}/${addressesToFetch.length} tokens`);

    // Update cache and result with DexScreener prices
    for (const [mint, price] of dexscreenerPrices.entries()) {
      this.priceCache.set(mint, {
        price: { priceUsd: price, timestamp: now },
                  timestamp: now,
                });
      result.set(mint, price);
              }

    // Step 2: For tokens not found in DexScreener, try Birdeye (if API key is set)
    const missingFromDexScreener = addressesToFetch.filter(
      addr => !dexscreenerPrices.has(addr.toLowerCase())
    );

    if (missingFromDexScreener.length > 0 && this.birdeyeApiKey) {
      console.log(`   📡 Fetching ${missingFromDexScreener.length} missing prices from Birdeye API (fallback)...`);
      
      // Use Birdeye only for missing tokens (much fewer requests!)
      // Process sequentially with delays to respect rate limits
      for (const mintAddress of missingFromDexScreener) {
        try {
          const price = await this.getTokenPrice(mintAddress); // Uses Birdeye
          if (price !== null) {
            result.set(mintAddress.toLowerCase(), price);
          }

          // Small delay to respect rate limits (1 request per second)
          await new Promise(resolve => setTimeout(resolve, 1100));
    } catch (error: any) {
          console.warn(`⚠️  Error fetching price for ${mintAddress} from Birdeye:`, error.message);
    }
      }
    }

    console.log(`   ✅ Total: Got prices for ${result.size}/${mintAddresses.length} tokens`);
    return result;
  }

  /**
   * Clear cache (useful for testing or manual refresh)
   */
  clearCache() {
    this.priceCache.clear();
  }
}
