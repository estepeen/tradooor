/**
 * Signal Quality Filter Service
 *
 * Advanced filters for improving signal quality:
 * 1. Volume filter - check buy/sell ratio (more buying = healthier)
 * 2. Price momentum - check recent price trend (avoid dumping tokens)
 * 3. Holder concentration - reject if top holders control too much
 *
 * All filters are configurable and can be easily adjusted.
 */

import { TokenMarketData } from './token-market-data.service.js';
import { RugCheckReport } from './rugcheck.service.js';

// =============================================
// FILTER CONFIGURATION
// =============================================

/**
 * Volume Filter Configuration
 * Checks buy/sell ratio to detect healthy buying pressure
 */
export const VOLUME_FILTER_CONFIG = {
  // Minimum buy/sell ratio (buys / sells)
  // 1.0 = equal, >1.0 = more buying, <1.0 = more selling
  MIN_BUY_SELL_RATIO: 0.5,  // Allow some selling, but not massive dumps

  // Minimum number of transactions in 5 minutes to consider ratio reliable
  MIN_TRANSACTIONS_FOR_RATIO: 3,

  // If price is dropping AND selling > buying, reject
  REJECT_ON_DUMP: true,
};

/**
 * Price Momentum Filter Configuration
 * Checks recent price movement to avoid buying into dumps
 */
export const PRICE_MOMENTUM_CONFIG = {
  // Maximum allowed price drop in 5 minutes (%)
  // -10% in 5 min = likely dump, avoid
  MAX_PRICE_DROP_5M: -15,

  // Maximum allowed price drop in 1 hour (%)
  MAX_PRICE_DROP_1H: -30,

  // If enabled, also check that price isn't at extreme pump (might be top)
  CHECK_EXTREME_PUMP: false,
  MAX_PRICE_PUMP_5M: 100, // Don't buy if already +100% in 5 min
};

/**
 * Holder Concentration Filter Configuration
 * Rejects tokens where few wallets control too much supply
 */
export const HOLDER_CONCENTRATION_CONFIG = {
  // Maximum allowed percentage for top 5 holders combined
  MAX_TOP_5_HOLDER_PERCENT: 70,

  // Maximum allowed percentage for top 10 holders combined
  MAX_TOP_10_HOLDER_PERCENT: 80,

  // Maximum allowed percentage for single top holder
  MAX_SINGLE_HOLDER_PERCENT: 40,
};

// =============================================
// FILTER RESULT INTERFACE
// =============================================

export interface QualityFilterResult {
  passed: boolean;
  reason?: string;
  details?: {
    buySellRatio?: number;
    priceChange5m?: number;
    priceChange1h?: number;
    top10HolderPercent?: number;
    topHolderPercent?: number;
  };
}

// =============================================
// SIGNAL QUALITY FILTER SERVICE
// =============================================

export class SignalQualityFilterService {
  /**
   * Run all quality filters on a signal
   * Returns passed: true if ALL filters pass
   *
   * @param marketData - Partial market data (only needs the fields used by filters)
   * @param rugCheckReport - RugCheck report for holder concentration
   */
  checkSignalQuality(
    marketData: Partial<TokenMarketData> | null,
    rugCheckReport: RugCheckReport | null
  ): QualityFilterResult {
    const details: QualityFilterResult['details'] = {};

    // 1. Volume Filter
    if (marketData) {
      const volumeResult = this.checkVolumeFilter(marketData);
      if (!volumeResult.passed) {
        return {
          passed: false,
          reason: volumeResult.reason,
          details: { buySellRatio: marketData.buySellRatio5m ?? undefined },
        };
      }
      details.buySellRatio = marketData.buySellRatio5m ?? undefined;
    }

    // 2. Price Momentum Filter
    if (marketData) {
      const momentumResult = this.checkPriceMomentum(marketData);
      if (!momentumResult.passed) {
        return {
          passed: false,
          reason: momentumResult.reason,
          details: {
            priceChange5m: marketData.priceChange5m ?? undefined,
            priceChange1h: marketData.priceChange1h ?? undefined,
          },
        };
      }
      details.priceChange5m = marketData.priceChange5m ?? undefined;
      details.priceChange1h = marketData.priceChange1h ?? undefined;
    }

    // 3. Holder Concentration Filter
    if (rugCheckReport) {
      const holderResult = this.checkHolderConcentration(rugCheckReport);
      if (!holderResult.passed) {
        return {
          passed: false,
          reason: holderResult.reason,
          details: {
            top10HolderPercent: rugCheckReport.top10HoldersPercent,
            topHolderPercent: rugCheckReport.topHolderPercent,
          },
        };
      }
      details.top10HolderPercent = rugCheckReport.top10HoldersPercent;
      details.topHolderPercent = rugCheckReport.topHolderPercent;
    }

    return { passed: true, details };
  }

  /**
   * Check buy/sell volume ratio
   * Healthy tokens have more buying than selling
   */
  checkVolumeFilter(marketData: Partial<TokenMarketData>): QualityFilterResult {
    const { buys5m, sells5m, buySellRatio5m, priceChange5m } = marketData;

    // If we don't have transaction data, pass the filter (don't block)
    if (buys5m === null || buys5m === undefined ||
        sells5m === null || sells5m === undefined) {
      return { passed: true };
    }

    // Need minimum transactions for reliable ratio
    const totalTxns = buys5m + sells5m;
    if (totalTxns < VOLUME_FILTER_CONFIG.MIN_TRANSACTIONS_FOR_RATIO) {
      return { passed: true }; // Not enough data, pass
    }

    // Check buy/sell ratio
    if (buySellRatio5m !== null && buySellRatio5m !== undefined) {
      // Special case: If price is dropping AND more selling than buying = DUMP
      if (VOLUME_FILTER_CONFIG.REJECT_ON_DUMP &&
          priceChange5m !== null && priceChange5m !== undefined &&
          priceChange5m < -5 && // Price dropping > 5%
          buySellRatio5m < 0.8) { // More sells than buys
        return {
          passed: false,
          reason: `DUMP detected: price ${priceChange5m.toFixed(1)}% with buy/sell ratio ${buySellRatio5m.toFixed(2)}`,
        };
      }

      // Check minimum ratio
      if (buySellRatio5m < VOLUME_FILTER_CONFIG.MIN_BUY_SELL_RATIO) {
        return {
          passed: false,
          reason: `Buy/sell ratio ${buySellRatio5m.toFixed(2)} below minimum ${VOLUME_FILTER_CONFIG.MIN_BUY_SELL_RATIO}`,
        };
      }
    }

    return { passed: true };
  }

  /**
   * Check price momentum
   * Avoid buying into dumps
   */
  checkPriceMomentum(marketData: Partial<TokenMarketData>): QualityFilterResult {
    const { priceChange5m, priceChange1h } = marketData;

    // Check 5 minute price drop
    if (priceChange5m !== null && priceChange5m !== undefined) {
      if (priceChange5m < PRICE_MOMENTUM_CONFIG.MAX_PRICE_DROP_5M) {
        return {
          passed: false,
          reason: `Price dropped ${priceChange5m.toFixed(1)}% in 5 min (max allowed: ${PRICE_MOMENTUM_CONFIG.MAX_PRICE_DROP_5M}%)`,
        };
      }

      // Check for extreme pump (optional)
      if (PRICE_MOMENTUM_CONFIG.CHECK_EXTREME_PUMP &&
          priceChange5m > PRICE_MOMENTUM_CONFIG.MAX_PRICE_PUMP_5M) {
        return {
          passed: false,
          reason: `Price pumped ${priceChange5m.toFixed(1)}% in 5 min - might be top`,
        };
      }
    }

    // Check 1 hour price drop
    if (priceChange1h !== null && priceChange1h !== undefined) {
      if (priceChange1h < PRICE_MOMENTUM_CONFIG.MAX_PRICE_DROP_1H) {
        return {
          passed: false,
          reason: `Price dropped ${priceChange1h.toFixed(1)}% in 1 hour (max allowed: ${PRICE_MOMENTUM_CONFIG.MAX_PRICE_DROP_1H}%)`,
        };
      }
    }

    return { passed: true };
  }

  /**
   * Check holder concentration
   * Reject if too few wallets control too much supply
   */
  checkHolderConcentration(rugCheckReport: RugCheckReport): QualityFilterResult {
    const { topHolderPercent, top10HoldersPercent } = rugCheckReport;

    // Check single top holder
    if (topHolderPercent !== undefined && topHolderPercent !== null) {
      if (topHolderPercent > HOLDER_CONCENTRATION_CONFIG.MAX_SINGLE_HOLDER_PERCENT) {
        return {
          passed: false,
          reason: `Top holder owns ${topHolderPercent.toFixed(1)}% (max allowed: ${HOLDER_CONCENTRATION_CONFIG.MAX_SINGLE_HOLDER_PERCENT}%)`,
        };
      }
    }

    // Check top 10 holders combined
    if (top10HoldersPercent !== undefined && top10HoldersPercent !== null) {
      if (top10HoldersPercent > HOLDER_CONCENTRATION_CONFIG.MAX_TOP_10_HOLDER_PERCENT) {
        return {
          passed: false,
          reason: `Top 10 holders own ${top10HoldersPercent.toFixed(1)}% (max allowed: ${HOLDER_CONCENTRATION_CONFIG.MAX_TOP_10_HOLDER_PERCENT}%)`,
        };
      }
    }

    return { passed: true };
  }
}

// Singleton instance
export const signalQualityFilter = new SignalQualityFilterService();
