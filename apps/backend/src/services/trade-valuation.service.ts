import { BinancePriceService } from './binance-price.service.js';
import { TokenPriceService } from './token-price.service.js';

export type ValuationSource = 'binance' | 'birdeye' | 'jupiter' | 'coingecko' | 'dexscreener' | 'stable';

export interface TradeValuationResult {
  amountBaseUsd: number;
  priceUsdPerToken: number;
  source: ValuationSource;
  timestamp: Date;
}

interface NormalizedValuationInput {
  baseToken: string;
  amountBaseRaw: number;
  amountToken: number; // Počet tokenů v trade
  priceBasePerTokenRaw: number;
  timestamp: Date;
  secondaryTokenMint?: string | null;
}

const USD_STABLES = new Set(['USDC', 'USDT', 'USDH', 'USDL', 'UXD']);

export class TradeValuationService {
  constructor(
    private readonly binancePriceService = new BinancePriceService(),
    private readonly tokenPriceService = new TokenPriceService()
  ) {}

  private normalizeBaseTokenSymbol(symbol: string) {
    return symbol?.toUpperCase().trim();
  }

  /**
   * Fetch token price from Jupiter API (free, Solana native)
   * Jupiter API: https://api.jup.ag/price/v2
   */
  private async fetchPriceFromJupiter(mintAddress: string): Promise<number | null> {
    try {
      const url = `https://price.jup.ag/v4/price?ids=${mintAddress}`;
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as any;
      if (data.data && data.data[mintAddress]) {
        const priceData = data.data[mintAddress];
        const priceUsd = parseFloat(priceData.price || '0');
        if (priceUsd > 0) {
          return priceUsd;
        }
      }
      return null;
    } catch (error: any) {
      console.warn(`⚠️  Jupiter API error for ${mintAddress.substring(0, 8)}...: ${error.message}`);
      return null;
    }
  }

  /**
   * Fetch token price from CoinGecko API (free tier: 10-50 calls/min)
   * CoinGecko API: https://api.coingecko.com/api/v3/simple/token_price/solana
   * Note: CoinGecko uses contract addresses, not mint addresses directly
   */
  private async fetchPriceFromCoinGecko(mintAddress: string): Promise<number | null> {
    try {
      // CoinGecko requires contract address format
      // For Solana, we need to use the mint address directly
      const url = `https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${mintAddress}&vs_currencies=usd`;
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as any;
      if (data && data[mintAddress.toLowerCase()] && data[mintAddress.toLowerCase()].usd) {
        const priceUsd = parseFloat(data[mintAddress.toLowerCase()].usd);
        if (priceUsd > 0) {
          return priceUsd;
        }
      }
      return null;
    } catch (error: any) {
      console.warn(`⚠️  CoinGecko API error for ${mintAddress.substring(0, 8)}...: ${error.message}`);
      return null;
    }
  }

  /**
   * Try multiple price sources in order of preference
   * Returns price in USD or null if all sources fail
   */
  private async fetchTokenPriceWithFallbacks(
    mintAddress: string,
    timestamp: Date
  ): Promise<{ price: number | null; source: ValuationSource }> {
    // 1. Try Birdeye historical price (most accurate for historical data)
    try {
      const birdeyePrice = await this.tokenPriceService.getTokenPriceAtDate(mintAddress, timestamp);
      if (birdeyePrice && birdeyePrice > 0) {
        return { price: birdeyePrice, source: 'birdeye' };
      }
    } catch (error: any) {
      console.warn(`⚠️  Birdeye historical price failed for ${mintAddress.substring(0, 8)}...: ${error.message}`);
    }

    // 2. Try Jupiter API (free, Solana native, good for current prices)
    // Note: Jupiter doesn't support historical prices, so we use current price as approximation
    const jupiterPrice = await this.fetchPriceFromJupiter(mintAddress);
    if (jupiterPrice && jupiterPrice > 0) {
      return { price: jupiterPrice, source: 'jupiter' };
    }

    // 3. Try CoinGecko API (free tier, good coverage)
    const coingeckoPrice = await this.fetchPriceFromCoinGecko(mintAddress);
    if (coingeckoPrice && coingeckoPrice > 0) {
      return { price: coingeckoPrice, source: 'coingecko' };
    }

    // 4. Try DexScreener (already in TokenPriceService, but try batch endpoint)
    try {
      const dexscreenerPrices = await this.tokenPriceService.getTokenPricesBatch([mintAddress]);
      const dexscreenerPrice = dexscreenerPrices.get(mintAddress.toLowerCase());
      if (dexscreenerPrice && dexscreenerPrice > 0) {
        return { price: dexscreenerPrice, source: 'dexscreener' };
      }
    } catch (error: any) {
      console.warn(`⚠️  DexScreener price failed for ${mintAddress.substring(0, 8)}...: ${error.message}`);
    }

    // 5. Try Birdeye current price as last resort
    try {
      const birdeyeCurrentPrice = await this.tokenPriceService.getTokenPrice(mintAddress);
      if (birdeyeCurrentPrice && birdeyeCurrentPrice > 0) {
        return { price: birdeyeCurrentPrice, source: 'birdeye' };
      }
    } catch (error: any) {
      console.warn(`⚠️  Birdeye current price failed for ${mintAddress.substring(0, 8)}...: ${error.message}`);
    }

    return { price: null, source: 'birdeye' };
  }

  async valuate(input: NormalizedValuationInput): Promise<TradeValuationResult> {
    const normalizedBaseToken = this.normalizeBaseTokenSymbol(input.baseToken);
    const timestamp = input.timestamp ?? new Date();

    // Stablecoins → 1:1 USD
    if (USD_STABLES.has(normalizedBaseToken)) {
      return {
        amountBaseUsd: input.amountBaseRaw,
        priceUsdPerToken: input.priceBasePerTokenRaw,
        source: 'stable',
        timestamp,
      };
    }

    // SOL → Binance price
    if (normalizedBaseToken === 'SOL' || normalizedBaseToken === 'WSOL') {
      const solPrice = await this.binancePriceService.getSolPriceAtTimestamp(timestamp);
      // 1. Najít cenu SOL v danou dobu
      // 2. Vynásobit počet SOL v trade (amountBaseRaw) * solPrice → USD hodnota
      const usdValue = input.amountBaseRaw * solPrice;
      // 3. Token price = USD hodnota / počet tokenů
      const priceUsdPerToken = input.amountToken > 0 ? usdValue / input.amountToken : 0;
      
      return {
        amountBaseUsd: usdValue,
        priceUsdPerToken,
        source: 'binance',
        timestamp,
      };
    }

    // Token-to-token swap → Try multiple price sources
    if (input.secondaryTokenMint) {
      // DŮLEŽITÉ: Pokud je base token SOL, můžeme vypočítat cenu přímo z trade dat!
      // 1. Najít cenu SOL v danou dobu
      // 2. Vynásobit počet SOL v trade (amountBaseRaw) * solPrice → USD hodnota
      // 3. Token price = USD hodnota / počet tokenů
      if (normalizedBaseToken === 'SOL' || normalizedBaseToken === 'WSOL') {
        try {
          const solPrice = await this.binancePriceService.getSolPriceAtTimestamp(timestamp);
          // USD hodnota = amountBaseRaw * solPrice
          const usdValue = input.amountBaseRaw * solPrice;
          // Token price = USD hodnota / počet tokenů
          const priceUsdPerToken = input.amountToken > 0 ? usdValue / input.amountToken : 0;

          return {
            amountBaseUsd: usdValue,
            priceUsdPerToken,
            source: 'binance',
            timestamp,
          };
        } catch (error: any) {
          throw new Error(
            `Failed to fetch SOL price for token-to-token swap: ${error.message}. Cannot determine USD value for base token ${input.secondaryTokenMint}`
          );
        }
      }

      // Pro non-SOL base tokeny zkusíme najít cenu z API
      const { price: secondaryPrice, source: priceSource } = await this.fetchTokenPriceWithFallbacks(
        input.secondaryTokenMint,
        timestamp
      );

      if (secondaryPrice && secondaryPrice > 0) {
        const usdValue = input.amountBaseRaw * secondaryPrice;
        
        // Sanity check: warn if value seems unusually large
        if (usdValue > 10_000_000) {
          console.warn(
            `⚠️  Trade valuation: computed value $${usdValue.toFixed(
              2
            )} for base token ${input.secondaryTokenMint.substring(0, 8)}... looks unusually large (source: ${priceSource})`
          );
        }

        return {
          amountBaseUsd: usdValue,
          priceUsdPerToken: input.priceBasePerTokenRaw * secondaryPrice,
          source: priceSource,
          timestamp,
        };
      }

      // Všechny API selhaly - trade zůstane void/pending
      // Lepší než uložit špatnou hodnotu
      throw new Error(
        `All price APIs failed for base token ${input.secondaryTokenMint.substring(0, 8)}... at ${timestamp.toISOString()}. Trade will be retried later.`
      );
    }

    throw new Error('Unsupported base token configuration – unable to determine USD value');
  }
}

