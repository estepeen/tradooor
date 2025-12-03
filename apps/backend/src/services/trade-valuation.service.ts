import { BinancePriceService } from './binance-price.service.js';
import { TokenPriceService } from './token-price.service.js';

export type ValuationSource = 'binance' | 'birdeye' | 'stable';

export interface TradeValuationResult {
  amountBaseUsd: number;
  priceUsdPerToken: number;
  source: ValuationSource;
  timestamp: Date;
}

interface NormalizedValuationInput {
  baseToken: string;
  amountBaseRaw: number;
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
      return {
        amountBaseUsd: input.amountBaseRaw * solPrice,
        priceUsdPerToken: input.priceBasePerTokenRaw * solPrice,
        source: 'binance',
        timestamp,
      };
    }

    // Token-to-token swap → Birdeye price for secondary token (base leg)
    if (input.secondaryTokenMint) {
      const secondaryPrice = await this.tokenPriceService.getTokenPriceAtDate(
        input.secondaryTokenMint,
        timestamp
      );

      if (secondaryPrice && secondaryPrice > 0) {
        const usdValue = input.amountBaseRaw * secondaryPrice;
        // Guard unrealistic valuations (> $10M) – fallback to SOL pricing
        if (usdValue > 10_000_000) {
          console.warn(
            `⚠️  Trade valuation: computed value $${usdValue.toFixed(
              2
            )} seems too large, falling back to SOL pricing`
          );
        } else {
          return {
            amountBaseUsd: usdValue,
            priceUsdPerToken: input.priceBasePerTokenRaw * secondaryPrice,
            source: 'birdeye',
            timestamp,
          };
        }
      }
    }

    // Fallback: treat as SOL exposure if all else fails
    const fallbackSolPrice = await this.binancePriceService.getSolPriceAtTimestamp(timestamp);
    return {
      amountBaseUsd: input.amountBaseRaw * fallbackSolPrice,
      priceUsdPerToken: input.priceBasePerTokenRaw * fallbackSolPrice,
      source: 'binance',
      timestamp,
    };
  }
}

