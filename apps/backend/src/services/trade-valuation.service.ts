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
      let secondaryPrice = await this.tokenPriceService.getTokenPriceAtDate(
        input.secondaryTokenMint,
        timestamp
      );

      if (!secondaryPrice || secondaryPrice <= 0) {
        const fallbackPrices = await this.tokenPriceService.getTokenPricesBatch([
          input.secondaryTokenMint,
        ]);
        secondaryPrice = fallbackPrices.get(input.secondaryTokenMint.toLowerCase()) ?? null;
      }

      if (secondaryPrice && secondaryPrice > 0) {
        const usdValue = input.amountBaseRaw * secondaryPrice;
        if (usdValue > 10_000_000) {
          console.warn(
            `⚠️  Trade valuation: computed value $${usdValue.toFixed(
              2
            )} for base token ${input.secondaryTokenMint.substring(0, 8)}... looks unusually large`
          );
        }

        return {
          amountBaseUsd: usdValue,
          priceUsdPerToken: input.priceBasePerTokenRaw * secondaryPrice,
          source: 'birdeye',
          timestamp,
        };
      }

      throw new Error(
        `Missing USD price for base token ${input.secondaryTokenMint} at ${timestamp.toISOString()}`
      );
    }

    throw new Error('Unsupported base token configuration – unable to determine USD value');
  }
}

