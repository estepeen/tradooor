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
   * Check if baseToken is actually SOL/WSOL (not a token mint address)
   */
  private isSolBaseToken(baseToken: string): boolean {
    const normalized = this.normalizeBaseTokenSymbol(baseToken);
    return normalized === 'SOL' || normalized === 'WSOL' || 
           baseToken === 'So11111111111111111111111111111111111111112';
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

    // DŮLEŽITÉ: Po změně v normalizeQuickNodeSwap už NIKDY nepřichází secondaryTokenMint
    // Všechny swapy teď mají baseToken = SOL/USDC/USDT (z balance changes)
    // Pokud by secondaryTokenMint přišlo, je to stará data nebo bug - ignoruj to
    if (input.secondaryTokenMint) {
      console.warn(
        `⚠️  [TradeValuation] Unexpected secondaryTokenMint: ${input.secondaryTokenMint.substring(0, 8)}... for baseToken: ${normalizedBaseToken}. This should not happen after normalizeQuickNodeSwap fix.`
      );
      // Fallback: pokud baseToken není SOL/USDC/USDT, zkus najít cenu
      if (!this.isSolBaseToken(normalizedBaseToken) && !USD_STABLES.has(normalizedBaseToken)) {
        // Toto by se nemělo stát, ale pro jistotu zkus najít cenu
        const { price: baseTokenPrice, source: priceSource } = await this.fetchTokenPriceWithFallbacks(
          input.secondaryTokenMint,
          timestamp
        );

        if (baseTokenPrice && baseTokenPrice > 0) {
          const usdValue = input.amountBaseRaw * baseTokenPrice;
          const priceUsdPerToken = input.amountToken > 0 ? usdValue / input.amountToken : 0;
          return {
            amountBaseUsd: usdValue,
            priceUsdPerToken,
            source: priceSource,
            timestamp,
          };
        }
      }
    }

    throw new Error('Unsupported base token configuration – unable to determine USD value');
  }
}

