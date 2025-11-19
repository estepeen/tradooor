import { Connection, PublicKey } from '@solana/web3.js';
import { HeliusClient } from './helius-client.service.js';

/**
 * Service pro získávání token metadata z různých zdrojů
 * Prioritizuje: Birdeye API > DexScreener > Metaplex on-chain > Helius API > Jupiter Token List
 */
export class TokenMetadataService {
  private connection: Connection;
  private heliusClient: HeliusClient;
  private birdeyeApiKey: string | undefined;
  private metaplexMetadataProgram = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

  constructor(heliusClient: HeliusClient, rpcUrl?: string) {
    this.connection = new Connection(rpcUrl || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
    this.heliusClient = heliusClient;
    this.birdeyeApiKey = process.env.BIRDEYE_API_KEY;
  }

  /**
   * Získání token metadata z Metaplex Token Metadata Program (on-chain)
   * Používá getParsedAccountInfo pro jednodušší parsování
   */
  private async getMetaplexMetadata(mintAddress: string): Promise<{
    symbol?: string;
    name?: string;
    decimals?: number;
  } | null> {
    try {
      const mintPubkey = new PublicKey(mintAddress);
      
      // Metaplex metadata account se nachází na PDA: ['metadata', metadata_program, mint]
      const [metadataPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('metadata'),
          this.metaplexMetadataProgram.toBuffer(),
          mintPubkey.toBuffer(),
        ],
        this.metaplexMetadataProgram
      );

      // Získej parsed account info
      const accountInfo = await this.connection.getParsedAccountInfo(metadataPDA);
      if (!accountInfo.value || !('parsed' in accountInfo.value.data)) {
        return null;
      }

      const parsed = accountInfo.value.data.parsed as any;
      
      // Zkus různé struktury, které může Metaplex mít
      const data = parsed.data || parsed.info?.data || parsed;
      
      if (data.name || data.symbol) {
        return {
          name: data.name || undefined,
          symbol: data.symbol || undefined,
          decimals: undefined,
        };
      }

      return null;
    } catch (error: any) {
      // Ignoruj chyby - zkusíme jiný zdroj
      return null;
    }
  }

  /**
   * Získání token metadata z DexScreener API (zdarma, bez API key)
   * DexScreener má dobré pokrytí tokenů na Solaně
   */
  private async getDexScreenerMetadata(mintAddress: string): Promise<{
    symbol?: string;
    name?: string;
    decimals?: number;
  } | null> {
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`;
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      if (data.pairs && data.pairs.length > 0) {
        // Vezmi první pair, který má token info
        const pair = data.pairs.find((p: any) => 
          p.baseToken?.address?.toLowerCase() === mintAddress.toLowerCase() ||
          p.quoteToken?.address?.toLowerCase() === mintAddress.toLowerCase()
        ) || data.pairs[0];

        const token = pair.baseToken?.address?.toLowerCase() === mintAddress.toLowerCase()
          ? pair.baseToken
          : pair.quoteToken;

        if (token && (token.symbol || token.name)) {
          return {
            symbol: token.symbol || undefined,
            name: token.name || undefined,
            decimals: undefined, // DexScreener nemá decimals
          };
        }
      }

      return null;
    } catch (error: any) {
      return null;
    }
  }

  /**
   * Získání token metadata z Birdeye API
   * Birdeye má dobré pokrytí tokenů na Solaně
   */
  private async getBirdeyeMetadata(mintAddress: string): Promise<{
    symbol?: string;
    name?: string;
    decimals?: number;
  } | null> {
    if (!this.birdeyeApiKey) {
      return null;
    }

    try {
      const url = `https://public-api.birdeye.so/v1/token/meta?address=${mintAddress}`;
      const response = await fetch(url, {
        headers: {
          'X-API-KEY': this.birdeyeApiKey,
        },
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      if (data.success && data.data) {
        return {
          symbol: data.data.symbol || undefined,
          name: data.data.name || undefined,
          decimals: data.data.decimals,
        };
      }

      return null;
    } catch (error: any) {
      return null;
    }
  }

  /**
   * Získání decimals z mint account (on-chain)
   */
  private async getDecimals(mintAddress: string): Promise<number | undefined> {
    try {
      const mintPubkey = new PublicKey(mintAddress);
      const mintInfo = await this.connection.getParsedAccountInfo(mintPubkey);
      
      if (mintInfo.value && 'parsed' in mintInfo.value.data) {
        const parsed = mintInfo.value.data.parsed as any;
        if (parsed.info && parsed.info.decimals !== undefined) {
          return parsed.info.decimals;
        }
      }
      
      return undefined;
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Hlavní metoda pro získání token metadata
   * Zkouší různé zdroje v pořadí priority
   * Prioritizujeme Birdeye (spolehlivější) > DexScreener > Metaplex > Helius
   */
  async getTokenMetadata(mintAddress: string): Promise<{
    symbol?: string;
    name?: string;
    decimals?: number;
  } | null> {
    // 1. Zkus Birdeye API (pokud máme API key - spolehlivější a přesnější)
    const birdeyeData = await this.getBirdeyeMetadata(mintAddress);
    if (birdeyeData && (birdeyeData.symbol || birdeyeData.name)) {
      return birdeyeData;
    }

    // 2. Zkus DexScreener API (zdarma, bez API key, dobré pokrytí - fallback)
    const dexscreenerData = await this.getDexScreenerMetadata(mintAddress);
    if (dexscreenerData && (dexscreenerData.symbol || dexscreenerData.name)) {
      // Doplň decimals pokud chybí
      if (dexscreenerData.decimals === undefined) {
        dexscreenerData.decimals = await this.getDecimals(mintAddress);
      }
      return dexscreenerData;
    }

    // 3. Zkus Metaplex on-chain metadata
    const metaplexData = await this.getMetaplexMetadata(mintAddress);
    if (metaplexData && (metaplexData.symbol || metaplexData.name)) {
      // Doplň decimals pokud chybí
      if (metaplexData.decimals === undefined) {
        metaplexData.decimals = await this.getDecimals(mintAddress);
      }
      return metaplexData;
    }

    // 4. Zkus Helius API (fallback)
    if (this.heliusClient.isAvailable()) {
      const heliusData = await this.heliusClient.getTokenInfo(mintAddress);
      if (heliusData && (heliusData.symbol || heliusData.name)) {
        return heliusData;
      }
    }

    return null;
  }

  /**
   * Batch získání token metadata z DexScreener
   * DexScreener podporuje batch requests přes comma-separated addresses
   */
  private async getDexScreenerMetadataBatch(mintAddresses: string[]): Promise<Map<string, {
    symbol?: string;
    name?: string;
    decimals?: number;
  }>> {
    const result = new Map<string, { symbol?: string; name?: string; decimals?: number }>();
    
    if (mintAddresses.length === 0) {
      return result;
    }

    try {
      // DexScreener podporuje batch requests - max 30 tokenů najednou
      const BATCH_SIZE = 30;
      
      for (let i = 0; i < mintAddresses.length; i += BATCH_SIZE) {
        const batch = mintAddresses.slice(i, i + BATCH_SIZE);
        const addressesParam = batch.join(',');
        
        const url = `https://api.dexscreener.com/latest/dex/tokens/${addressesParam}`;
        const response = await fetch(url, {
          headers: {
            'Accept': 'application/json',
          },
        });

        if (!response.ok) {
          continue;
        }

        const data = await response.json();
        if (data.pairs && Array.isArray(data.pairs)) {
          // Vytvoř mapu mintAddress -> token info
          const tokenMap = new Map<string, any>();
          
          data.pairs.forEach((pair: any) => {
            if (pair.baseToken) {
              const addr = pair.baseToken.address?.toLowerCase();
              if (addr && batch.some(b => b.toLowerCase() === addr)) {
                tokenMap.set(addr, pair.baseToken);
              }
            }
            if (pair.quoteToken) {
              const addr = pair.quoteToken.address?.toLowerCase();
              if (addr && batch.some(b => b.toLowerCase() === addr)) {
                tokenMap.set(addr, pair.quoteToken);
              }
            }
          });

          // Přidej do výsledku
          batch.forEach(mintAddress => {
            const token = tokenMap.get(mintAddress.toLowerCase());
            if (token && (token.symbol || token.name)) {
              result.set(mintAddress, {
                symbol: token.symbol || undefined,
                name: token.name || undefined,
                decimals: undefined,
              });
            }
          });
        }

        // Delay mezi batch requests
        if (i + BATCH_SIZE < mintAddresses.length) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
    } catch (error: any) {
      // Ignoruj chyby
    }

    return result;
  }

  /**
   * Batch získání token metadata
   * Optimalizováno pro více tokenů najednou
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

    // 1. Zkus Birdeye API pro všechny tokeny (spolehlivější a přesnější)
    const birdeyePromises = mintAddresses.map(async (mintAddress) => {
      const metadata = await this.getBirdeyeMetadata(mintAddress);
      if (metadata && (metadata.symbol || metadata.name)) {
        return { mintAddress, metadata };
      }
      return { mintAddress, metadata: null };
    });

    // Process Birdeye in smaller batches to avoid rate limits
    const BATCH_SIZE = 5;
    for (let i = 0; i < birdeyePromises.length; i += BATCH_SIZE) {
      const batch = birdeyePromises.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch);
      
      batchResults.forEach(({ mintAddress, metadata }) => {
        if (metadata) {
          result.set(mintAddress, metadata);
        }
      });

      // Small delay between batches
      if (i + BATCH_SIZE < birdeyePromises.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    // 2. Pro tokeny, které Birdeye nenašel, zkus DexScreener batch (fallback)
    const remaining = mintAddresses.filter(m => !result.has(m));
    if (remaining.length > 0) {
      const dexscreenerResults = await this.getDexScreenerMetadataBatch(remaining);
      dexscreenerResults.forEach((info, mint) => {
        result.set(mint, info);
      });
    }

    // 3. Pro tokeny, které Birdeye ani DexScreener nenašel, zkus ostatní zdroje
    const stillRemaining = mintAddresses.filter(m => !result.has(m));
    
    if (stillRemaining.length > 0) {
      // Paralelně zpracuj zbývající tokeny (menší batch)
      const BATCH_SIZE = 5;
      
      for (let i = 0; i < stillRemaining.length; i += BATCH_SIZE) {
        const batch = stillRemaining.slice(i, i + BATCH_SIZE);
        
        await Promise.all(
          batch.map(async (mintAddress) => {
            // Use getTokenMetadata but skip Birdeye since we already tried it
            // Try DexScreener, Metaplex, Helius
            const dexscreenerData = await this.getDexScreenerMetadata(mintAddress);
            if (dexscreenerData && (dexscreenerData.symbol || dexscreenerData.name)) {
              if (dexscreenerData.decimals === undefined) {
                dexscreenerData.decimals = await this.getDecimals(mintAddress);
              }
              return { mintAddress, metadata: dexscreenerData };
            }

            const metaplexData = await this.getMetaplexMetadata(mintAddress);
            if (metaplexData && (metaplexData.symbol || metaplexData.name)) {
              if (metaplexData.decimals === undefined) {
                metaplexData.decimals = await this.getDecimals(mintAddress);
              }
              return { mintAddress, metadata: metaplexData };
            }

            if (this.heliusClient.isAvailable()) {
              const heliusData = await this.heliusClient.getTokenInfo(mintAddress);
              if (heliusData && (heliusData.symbol || heliusData.name)) {
                return { mintAddress, metadata: heliusData };
              }
            }

            return { mintAddress, metadata: null };
          })
        ).then((results) => {
          results.forEach(({ mintAddress, metadata }) => {
            if (metadata) {
              result.set(mintAddress, metadata);
            }
          });
        });

        // Malý delay mezi batch requests
        if (i + BATCH_SIZE < stillRemaining.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }

    // Doplň decimals pro všechny tokeny, které je nemají
    const decimalsPromises = Array.from(result.entries()).map(async ([mint, info]) => {
      if (info.decimals === undefined) {
        const decimals = await this.getDecimals(mint);
        if (decimals !== undefined) {
          info.decimals = decimals;
        }
      }
    });
    await Promise.all(decimalsPromises);

    return result;
  }
}

