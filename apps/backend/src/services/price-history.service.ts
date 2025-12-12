/**
 * Service for tracking price history during position hold period
 * Used for accurate stop-loss/take-profit detection and max profit/drawdown calculation
 */

import { TokenPriceService } from './token-price.service.js';

interface PriceSnapshot {
  timestamp: Date;
  price: number;
}

interface PriceHistoryResult {
  maxPrice: number;
  minPrice: number;
  maxPriceTime: Date | null;
  minPriceTime: Date | null;
  maxProfitPercent: number;
  maxDrawdownPercent: number;
  timeToMaxProfitMinutes: number | null;
}

export class PriceHistoryService {
  private tokenPriceService: TokenPriceService;
  private priceCache = new Map<string, { price: number; timestamp: number }>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor() {
    this.tokenPriceService = new TokenPriceService();
  }

  /**
   * Get price history for a token during a specific time period
   * Uses Birdeye historical price API to get price snapshots
   * 
   * @param mintAddress - Token mint address
   * @param startTime - Start of the period
   * @param endTime - End of the period
   * @param intervalMinutes - Interval between price snapshots (default: 5 minutes)
   */
  async getPriceHistory(
    mintAddress: string,
    startTime: Date,
    endTime: Date,
    intervalMinutes: number = 5
  ): Promise<PriceSnapshot[]> {
    const snapshots: PriceSnapshot[] = [];
    const intervalMs = intervalMinutes * 60 * 1000;
    
    // Get price at start
    const startPrice = await this.getPriceAtTime(mintAddress, startTime);
    if (startPrice) {
      snapshots.push({ timestamp: startTime, price: startPrice });
    }

    // Get price at regular intervals
    let currentTime = new Date(startTime.getTime() + intervalMs);
    while (currentTime <= endTime) {
      const price = await this.getPriceAtTime(mintAddress, currentTime);
      if (price) {
        snapshots.push({ timestamp: currentTime, price });
      }
      currentTime = new Date(currentTime.getTime() + intervalMs);
    }

    // Get price at end
    const endPrice = await this.getPriceAtTime(mintAddress, endTime);
    if (endPrice) {
      snapshots.push({ timestamp: endTime, price: endPrice });
    }

    return snapshots;
  }

  /**
   * Get price at a specific timestamp
   * Uses Birdeye historical price API
   */
  private async getPriceAtTime(mintAddress: string, timestamp: Date): Promise<number | null> {
    // Check cache first
    const cacheKey = `${mintAddress}-${timestamp.getTime()}`;
    const cached = this.priceCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.price;
    }

    try {
      // TokenPriceService.getTokenPriceAtDate returns number | null
      const price = await this.tokenPriceService.getTokenPriceAtDate(mintAddress, timestamp);
      if (price !== null && price > 0) {
        this.priceCache.set(cacheKey, { price, timestamp: Date.now() });
        return price;
      }
    } catch (error: any) {
      console.warn(`⚠️  Failed to get price at time for ${mintAddress}: ${error.message}`);
    }

    return null;
  }

  /**
   * Calculate max profit, max drawdown, and time to max profit from price history
   * 
   * @param entryPrice - Entry price
   * @param exitPrice - Exit price
   * @param entryTime - Entry time
   * @param exitTime - Exit time
   * @param mintAddress - Token mint address (optional, for fetching price history)
   * @param priceHistory - Optional pre-fetched price history
   */
  async calculatePriceMetrics(
    entryPrice: number,
    exitPrice: number,
    entryTime: Date,
    exitTime: Date,
    mintAddress?: string,
    priceHistory?: PriceSnapshot[]
  ): Promise<PriceHistoryResult> {
    // If price history is provided, use it
    if (priceHistory && priceHistory.length > 0) {
      return this.calculateFromHistory(entryPrice, exitPrice, entryTime, exitTime, priceHistory);
    }

    // If mint address is provided, fetch price history
    if (mintAddress) {
      try {
        const history = await this.getPriceHistory(mintAddress, entryTime, exitTime);
        if (history.length > 0) {
          return this.calculateFromHistory(entryPrice, exitPrice, entryTime, exitTime, history);
        }
      } catch (error: any) {
        console.warn(`⚠️  Failed to fetch price history for ${mintAddress}: ${error.message}`);
      }
    }

    // Fallback: use entry/exit prices only
    return this.calculateFromEntryExit(entryPrice, exitPrice, entryTime, exitTime);
  }

  /**
   * Calculate metrics from price history
   */
  private calculateFromHistory(
    entryPrice: number,
    exitPrice: number,
    entryTime: Date,
    exitTime: Date,
    priceHistory: PriceSnapshot[]
  ): PriceHistoryResult {
    // Include entry and exit prices in calculation
    const allPrices = [
      { timestamp: entryTime, price: entryPrice },
      ...priceHistory,
      { timestamp: exitTime, price: exitPrice },
    ];

    // Find max and min prices
    let maxPrice = entryPrice;
    let minPrice = entryPrice;
    let maxPriceTime: Date | null = null;
    let minPriceTime: Date | null = null;

    for (const snapshot of allPrices) {
      if (snapshot.price > maxPrice) {
        maxPrice = snapshot.price;
        maxPriceTime = snapshot.timestamp;
      }
      if (snapshot.price < minPrice) {
        minPrice = snapshot.price;
        minPriceTime = snapshot.timestamp;
      }
    }

    // Calculate max profit and drawdown percentages
    const maxProfitPercent = entryPrice > 0 ? ((maxPrice - entryPrice) / entryPrice) * 100 : 0;
    const maxDrawdownPercent = entryPrice > 0 ? ((entryPrice - minPrice) / entryPrice) * 100 : 0;

    // Calculate time to max profit
    let timeToMaxProfitMinutes: number | null = null;
    if (maxPriceTime && maxPriceTime > entryTime) {
      timeToMaxProfitMinutes = Math.round((maxPriceTime.getTime() - entryTime.getTime()) / (1000 * 60));
    }

    return {
      maxPrice,
      minPrice,
      maxPriceTime,
      minPriceTime,
      maxProfitPercent,
      maxDrawdownPercent,
      timeToMaxProfitMinutes,
    };
  }

  /**
   * Fallback calculation using only entry/exit prices
   */
  private calculateFromEntryExit(
    entryPrice: number,
    exitPrice: number,
    entryTime: Date,
    exitTime: Date
  ): PriceHistoryResult {
    const maxPrice = Math.max(entryPrice, exitPrice);
    const minPrice = Math.min(entryPrice, exitPrice);
    const maxPriceTime = exitPrice > entryPrice ? exitTime : entryTime;
    const minPriceTime = exitPrice < entryPrice ? exitTime : entryTime;

    const maxProfitPercent = entryPrice > 0 ? ((maxPrice - entryPrice) / entryPrice) * 100 : 0;
    const maxDrawdownPercent = entryPrice > 0 ? ((entryPrice - minPrice) / entryPrice) * 100 : 0;

    let timeToMaxProfitMinutes: number | null = null;
    if (maxPriceTime > entryTime) {
      timeToMaxProfitMinutes = Math.round((maxPriceTime.getTime() - entryTime.getTime()) / (1000 * 60));
    }

    return {
      maxPrice,
      minPrice,
      maxPriceTime,
      minPriceTime,
      maxProfitPercent,
      maxDrawdownPercent,
      timeToMaxProfitMinutes,
    };
  }

  /**
   * Detect exit reason based on price history and exit price
   * 
   * @param entryPrice - Entry price
   * @param exitPrice - Exit price
   * @param maxProfitPercent - Maximum profit % during hold
   * @param maxDrawdownPercent - Maximum drawdown % during hold
   * @param realizedPnlPercent - Realized PnL %
   */
  detectExitReason(
    entryPrice: number,
    exitPrice: number,
    maxProfitPercent: number,
    maxDrawdownPercent: number,
    realizedPnlPercent: number
  ): 'take_profit' | 'stop_loss' | 'manual' | 'unknown' {
    // If exit price is close to max profit, likely take-profit
    const exitProfitPercent = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;
    const profitRatio = maxProfitPercent > 0 ? (exitProfitPercent / maxProfitPercent) : 0;

    // Take-profit: exit price is close to max profit (within 10% of max profit)
    if (profitRatio > 0.9 && realizedPnlPercent > 5) {
      return 'take_profit';
    }

    // Stop-loss: exit price is close to min price (within 10% of max drawdown)
    const exitLossPercent = entryPrice > 0 ? ((entryPrice - exitPrice) / entryPrice) * 100 : 0;
    const lossRatio = maxDrawdownPercent > 0 ? (exitLossPercent / maxDrawdownPercent) : 0;

    if (lossRatio > 0.9 && realizedPnlPercent < -5) {
      return 'stop_loss';
    }

    // Manual: exit price is somewhere in between
    if (Math.abs(realizedPnlPercent) < 10) {
      return 'manual';
    }

    return 'unknown';
  }
}
