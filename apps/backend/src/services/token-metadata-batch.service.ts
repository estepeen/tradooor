/**
 * TokenMetadataBatchService - Batch fetching token metadata s rate limitingem a cachováním v DB
 * 
 * Tento service:
 * 1. Batchuje requesty (max 100 mintů na request)
 * 2. Rate limiting (max 5 requestů za sekundu)
 * 3. Cachuje výsledky v DB (Token tabulka)
 * 4. Ignoruje base tokeny (SOL, USDC, USDT) - má je natvrdo definované
 */

import { TokenRepository } from '../repositories/token.repository.js';
import { TokenMetadataService } from './token-metadata.service.js';

// Base tokeny - máme je natvrdo definované
const BASE_TOKENS = new Set([
  'So11111111111111111111111111111111111111112', // SOL (wrapped)
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

const BASE_TOKEN_NAMES: Record<string, { symbol: string; name: string; decimals: number }> = {
  'So11111111111111111111111111111111111111112': { symbol: 'SOL', name: 'Solana', decimals: 9 },
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { symbol: 'USDT', name: 'Tether USD', decimals: 6 },
};

// Heuristika pro detekci „špatných“ symbolů, které vypadají jako contract adresy
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;
function isGarbageSymbol(symbol: string, mintAddress?: string | null): boolean {
  const sym = symbol.trim();
  if (!sym) return false;

  // Dlouhý čistý base58 string (pravděpodobně plná CA)
  if (sym.length > 15 && BASE58_REGEX.test(sym)) {
    return true;
  }

  // Zkrácená adresa s "..."
  if (sym.includes('...')) {
    return true;
  }

  // Symbol, který se rovná mint adrese (často při špatném importu)
  if (mintAddress && sym.toLowerCase() === mintAddress.toLowerCase()) {
    return true;
  }

  return false;
}

// Rate limiter: max 5 requestů za sekundu
const MAX_REQUESTS_PER_SECOND = 5;
const REQUEST_INTERVAL_MS = 1000;

class RateLimiter {
  private queue: Array<() => Promise<any>> = [];
  private processing = false;
  private requestTimes: number[] = [];

  async add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.process();
    });
  }

  private async process() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      // Odstraň staré requesty (starší než 1 sekunda)
      const now = Date.now();
      this.requestTimes = this.requestTimes.filter(time => now - time < REQUEST_INTERVAL_MS);

      // Pokud máme max requestů za sekundu, počkej
      if (this.requestTimes.length >= MAX_REQUESTS_PER_SECOND) {
        const oldestRequest = Math.min(...this.requestTimes);
        const waitTime = REQUEST_INTERVAL_MS - (now - oldestRequest);
        if (waitTime > 0) {
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        // Odstraň staré requesty znovu
        const now2 = Date.now();
        this.requestTimes = this.requestTimes.filter(time => now2 - time < REQUEST_INTERVAL_MS);
      }

      // Spusť request
      const fn = this.queue.shift();
      if (fn) {
        this.requestTimes.push(Date.now());
        await fn();
      }
    }

    this.processing = false;
  }
}

const rateLimiter = new RateLimiter();

export class TokenMetadataBatchService {
  constructor(
    private tokenRepo: TokenRepository
  ) {
    this.metadataService = new TokenMetadataService();
  }

  private metadataService: TokenMetadataService;

  /**
   * Získá token metadata pro seznam mint adres
   * - Ignoruje base tokeny (SOL, USDC, USDT)
   * - Cachuje v DB
   * - Batchuje requesty (max 100 mintů na request)
   * - Rate limiting (max 5 requestů za sekundu)
   */
  async getTokenMetadataBatch(mintAddresses: string[]): Promise<Map<string, {
    symbol?: string;
    name?: string;
    decimals?: number;
  }>> {
    const result = new Map<string, { symbol?: string; name?: string; decimals?: number }>();

    if (mintAddresses.length === 0) {
      return result;
    }

    // 1. Filtruj base tokeny a přidej je do výsledku
    const unknownMints: string[] = [];
    for (const mint of mintAddresses) {
      if (BASE_TOKENS.has(mint)) {
        const baseToken = BASE_TOKEN_NAMES[mint];
        if (baseToken) {
          result.set(mint, baseToken);
        }
      } else {
        unknownMints.push(mint);
      }
    }

    if (unknownMints.length === 0) {
      return result;
    }

    // 2. Zkontroluj, které tokeny už máme v DB
    const mintsToFetch: string[] = [];
    const dbCache = new Map<string, { symbol?: string; name?: string; decimals?: number }>();

    if (unknownMints.length > 0) {
      const tokensFromDb = await this.tokenRepo.findByMintAddresses(unknownMints);
      const tokenMap = new Map<string, any>();
      tokensFromDb.forEach(token => tokenMap.set(token.mintAddress, token));

      for (const mint of unknownMints) {
        const token = tokenMap.get(mint);
        if (token) {
          const sym = (token.symbol || '').trim();
          const name = (token.name || '').trim();
          const hasValidSymbol = sym && !isGarbageSymbol(sym, token.mintAddress);
          const hasValidName = !!name;

          if (hasValidSymbol || hasValidName) {
            dbCache.set(mint, {
              symbol: token.symbol || undefined,
              name: token.name || undefined,
              decimals: token.decimals,
            });
            result.set(mint, dbCache.get(mint)!);
            continue;
          }
        }

        // Potřebujeme fetchovat z API (buď token neexistuje, nebo má jen „garbage“ symbol)
        mintsToFetch.push(mint);
      }
    }

    if (mintsToFetch.length === 0) {
      return result;
    }

    console.log(`   🔍 Fetching metadata for ${mintsToFetch.length} tokens (${unknownMints.length - mintsToFetch.length} from cache)...`);

    // 3. Batch fetch z Helius API (max 100 mintů na request)
    const BATCH_SIZE = 100;
    const batches: string[][] = [];
    for (let i = 0; i < mintsToFetch.length; i += BATCH_SIZE) {
      batches.push(mintsToFetch.slice(i, i + BATCH_SIZE));
    }

        for (const batch of batches) {
      try {
        // PRIORITA: Zkus nejdřív TokenMetadataService (zkouší více zdrojů: Birdeye, DexScreener, Metaplex, Helius)
        // To je spolehlivější než jen Helius API
        console.log(`   🔍 Fetching metadata for ${batch.length} tokens via multiple sources (Birdeye/DexScreener/Metaplex/Helius)...`);
        let heliusInfoMap = new Map<string, { symbol?: string; name?: string; decimals?: number }>();
        
        try {
          // Zkus TokenMetadataService (více zdrojů)
          const multiSourceMetadata = await this.metadataService.getTokenMetadataBatch(batch);
          multiSourceMetadata.forEach((info, mint) => {
            heliusInfoMap.set(mint, info);
          });
          console.log(`   ✅ Found metadata for ${multiSourceMetadata.size}/${batch.length} tokens via multiple sources`);
        } catch (error: any) {
          console.warn(`   ⚠️  Error fetching from multiple sources: ${error.message}, falling back to Helius only`);
        }

        // Helius API removed - using webhook-only approach
        // Fallback to Helius API was removed to prevent API credit usage
        // We only use Birdeye, DexScreener, and Metaplex now
        // Missing tokens will remain without metadata until webhook provides it

        // Zkontroluj garbage symbols a zkus znovu pro ty, které mají garbage
        const extraFetchMints: string[] = [];
        for (const mint of batch) {
          const info = heliusInfoMap.get(mint) || {};
          const symbolGarbage = info.symbol ? isGarbageSymbol(info.symbol, mint) : false;
          
          if ((!info.symbol && !info.name) || symbolGarbage) {
            extraFetchMints.push(mint);
          }
        }

        if (extraFetchMints.length > 0) {
          try {
            console.log(`   🔄 Re-enriching ${extraFetchMints.length} tokens with missing/garbage symbols via secondary sources...`);
            const extraMetadata = await this.metadataService.getTokenMetadataBatch(extraFetchMints);
            extraMetadata.forEach((extra, mint) => {
              const existing = heliusInfoMap.get(mint) || {};
              // Použij extra metadata pouze pokud je lepší (má symbol/name a není garbage)
              const extraSymbolGarbage = extra.symbol ? isGarbageSymbol(extra.symbol, mint) : false;
              if (extra.symbol && !extraSymbolGarbage) {
                heliusInfoMap.set(mint, {
                  symbol: extra.symbol,
                  name: extra.name ?? existing.name,
                  decimals: extra.decimals ?? existing.decimals,
                });
              } else if (extra.name && !existing.name) {
                heliusInfoMap.set(mint, {
                  symbol: existing.symbol,
                  name: extra.name,
                  decimals: extra.decimals ?? existing.decimals,
                });
              }
            });
          } catch (error: any) {
            console.warn(`   ⚠️  Failed batch re-enrichment via secondary sources: ${error.message}`);
          }
        }

        for (const mint of batch) {
          const info = heliusInfoMap.get(mint) || {};
          try {
            if (info.symbol || info.name) {
              // Ulož do DB / aktualizuj
              const saved = await this.tokenRepo.findOrCreate({
                mintAddress: mint,
                symbol: info.symbol,
                name: info.name,
                decimals: info.decimals,
              });

              if (saved && (saved.symbol || saved.name)) {
                result.set(mint, {
                  symbol: saved.symbol || info.symbol,
                  name: saved.name || info.name,
                  decimals: saved.decimals ?? info.decimals,
                });
                console.log(`   ✅ Saved ${mint.substring(0, 8)}...: ${saved.symbol || saved.name}`);
              } else {
                console.warn(`   ⚠️  Failed to save metadata for ${mint.substring(0, 8)}... (no symbol/name after enrichment)`);
              }
            } else {
              await this.tokenRepo.findOrCreate({
                mintAddress: mint,
              });
              console.warn(`   ⚠️  No symbol/name for ${mint.substring(0, 8)}... (all sources empty)`);
            }
          } catch (error: any) {
            console.error(`   ❌ Error saving token ${mint.substring(0, 8)}...:`, error.message);
          }
        }
      } catch (error: any) {
        // Pokud je to 429 rate limit, propaguj chybu nahoru
        // HeliusRateLimitError was removed with Helius
        if (error && typeof error === 'object' && 'message' in error && String(error.message).includes('rate limit')) {
          throw error;
        }
        // Jiné chyby ignorujeme - tokeny budou bez symbolu/name
        console.warn(`   ⚠️  Error fetching batch token metadata: ${error.message}`);
      }
    }

    console.log(`   ✅ Found metadata for ${result.size}/${mintAddresses.length} tokens`);

    return result;
  }

  /**
   * Získá token metadata pro jeden mint (pro kompatibilitu)
   */
  async getTokenMetadata(mintAddress: string): Promise<{
    symbol?: string;
    name?: string;
    decimals?: number;
  } | null> {
    const result = await this.getTokenMetadataBatch([mintAddress]);
    return result.get(mintAddress) || null;
  }
}

