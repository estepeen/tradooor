import { prisma } from '../lib/prisma.js';

const toNumber = (value: any) => (value === null || value === undefined ? 0 : Number(value));

export interface ClosedLotRecord {
  id: string;
  walletId: string;
  tokenId: string;
  size: number;
  entryPrice: number;
  exitPrice: number;
  entryTime: Date;
  exitTime: Date;
  holdTimeMinutes: number;
  costBasis: number;
  proceeds: number;
  realizedPnl: number;
  realizedPnlPercent: number;
  realizedPnlUsd: number | null;
  buyTradeId: string | null;
  sellTradeId: string | null;
  isPreHistory: boolean;
  costKnown: boolean;
  sequenceNumber: number | null;
  
  // Entry/Exit Timing Metrics
  entryHourOfDay: number | null;
  entryDayOfWeek: number | null;
  exitHourOfDay: number | null;
  exitDayOfWeek: number | null;
  
  // Market Conditions at Entry/Exit
  entryMarketCap: number | null;
  exitMarketCap: number | null;
  entryLiquidity: number | null;
  exitLiquidity: number | null;
  entryVolume24h: number | null;
  exitVolume24h: number | null;
  tokenAgeAtEntryMinutes: number | null;
  
  // Stop-Loss/Take-Profit Detection
  exitReason: 'take_profit' | 'stop_loss' | 'manual' | 'unknown' | null;
  maxProfitPercent: number | null;
  maxDrawdownPercent: number | null;
  timeToMaxProfitMinutes: number | null;
  
  // DCA Tracking
  dcaEntryCount: number | null;
  dcaTimeSpanMinutes: number | null;
  
  // Re-entry Patterns
  reentryTimeMinutes: number | null;
  reentryPriceChangePercent: number | null;
  previousCyclePnl: number | null;
}

export class ClosedLotRepository {
  async findByWallet(walletId: string, options?: { fromDate?: Date; toDate?: Date }) {
    // DŮLEŽITÉ: Timeout protection pro načítání closed lots - prevence zasekávání
    const FETCH_TIMEOUT_MS = 60000; // 60 sekund
    
    const fetchPromise = (async () => {
      const where: any = { walletId };

      if (options?.fromDate) {
        where.exitTime = { gte: options.fromDate };
      }

      if (options?.toDate) {
        where.exitTime = { ...where.exitTime, lte: options.toDate };
      }

      const lots = await prisma.closedLot.findMany({
        where,
        orderBy: { exitTime: 'desc' },
      });

      return lots.map(this.mapRow);
    })();
    
    const timeoutPromise = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error('Closed lots fetch timeout')), FETCH_TIMEOUT_MS)
    );
    
    try {
      return await Promise.race([fetchPromise, timeoutPromise]);
    } catch (error: any) {
      if (error.message === 'Closed lots fetch timeout') {
        console.error(`⚠️  Timeout fetching closed lots for wallet ${walletId.substring(0, 8)}... after ${FETCH_TIMEOUT_MS}ms`);
        throw new Error(`Failed to fetch closed lots: timeout after ${FETCH_TIMEOUT_MS}ms. This wallet may have too many closed lots.`);
      }
      throw error;
    }
  }

  private mapRow(row: any): ClosedLotRecord {
    return {
      id: row.id,
      walletId: row.walletId,
      tokenId: row.tokenId,
      size: toNumber(row.size),
      entryPrice: toNumber(row.entryPrice),
      exitPrice: toNumber(row.exitPrice),
      entryTime: row.entryTime ? new Date(row.entryTime) : new Date(),
      exitTime: row.exitTime ? new Date(row.exitTime) : new Date(),
      holdTimeMinutes: toNumber(row.holdTimeMinutes),
      costBasis: toNumber(row.costBasis),
      proceeds: toNumber(row.proceeds),
      realizedPnl: toNumber(row.realizedPnl),
      realizedPnlPercent: toNumber(row.realizedPnlPercent),
      realizedPnlUsd: row.realizedPnlUsd !== null && row.realizedPnlUsd !== undefined ? toNumber(row.realizedPnlUsd) : null,
      buyTradeId: row.buyTradeId ?? null,
      sellTradeId: row.sellTradeId ?? null,
      isPreHistory: Boolean(row.isPreHistory),
      costKnown: row.costKnown !== undefined ? Boolean(row.costKnown) : true,
      sequenceNumber: row.sequenceNumber !== null && row.sequenceNumber !== undefined ? toNumber(row.sequenceNumber) : null,
      
      // Entry/Exit Timing Metrics
      entryHourOfDay: row.entryHourOfDay !== null && row.entryHourOfDay !== undefined ? toNumber(row.entryHourOfDay) : null,
      entryDayOfWeek: row.entryDayOfWeek !== null && row.entryDayOfWeek !== undefined ? toNumber(row.entryDayOfWeek) : null,
      exitHourOfDay: row.exitHourOfDay !== null && row.exitHourOfDay !== undefined ? toNumber(row.exitHourOfDay) : null,
      exitDayOfWeek: row.exitDayOfWeek !== null && row.exitDayOfWeek !== undefined ? toNumber(row.exitDayOfWeek) : null,
      
      // Market Conditions at Entry/Exit
      entryMarketCap: row.entryMarketCap !== null && row.entryMarketCap !== undefined ? toNumber(row.entryMarketCap) : null,
      exitMarketCap: row.exitMarketCap !== null && row.exitMarketCap !== undefined ? toNumber(row.exitMarketCap) : null,
      entryLiquidity: row.entryLiquidity !== null && row.entryLiquidity !== undefined ? toNumber(row.entryLiquidity) : null,
      exitLiquidity: row.exitLiquidity !== null && row.exitLiquidity !== undefined ? toNumber(row.exitLiquidity) : null,
      entryVolume24h: row.entryVolume24h !== null && row.entryVolume24h !== undefined ? toNumber(row.entryVolume24h) : null,
      exitVolume24h: row.exitVolume24h !== null && row.exitVolume24h !== undefined ? toNumber(row.exitVolume24h) : null,
      tokenAgeAtEntryMinutes: row.tokenAgeAtEntryMinutes !== null && row.tokenAgeAtEntryMinutes !== undefined ? toNumber(row.tokenAgeAtEntryMinutes) : null,
      
      // Stop-Loss/Take-Profit Detection
      exitReason: row.exitReason ?? null,
      maxProfitPercent: row.maxProfitPercent !== null && row.maxProfitPercent !== undefined ? toNumber(row.maxProfitPercent) : null,
      maxDrawdownPercent: row.maxDrawdownPercent !== null && row.maxDrawdownPercent !== undefined ? toNumber(row.maxDrawdownPercent) : null,
      timeToMaxProfitMinutes: row.timeToMaxProfitMinutes !== null && row.timeToMaxProfitMinutes !== undefined ? toNumber(row.timeToMaxProfitMinutes) : null,
      
      // DCA Tracking
      dcaEntryCount: row.dcaEntryCount !== null && row.dcaEntryCount !== undefined ? toNumber(row.dcaEntryCount) : null,
      dcaTimeSpanMinutes: row.dcaTimeSpanMinutes !== null && row.dcaTimeSpanMinutes !== undefined ? toNumber(row.dcaTimeSpanMinutes) : null,
      
      // Re-entry Patterns
      reentryTimeMinutes: row.reentryTimeMinutes !== null && row.reentryTimeMinutes !== undefined ? toNumber(row.reentryTimeMinutes) : null,
      reentryPriceChangePercent: row.reentryPriceChangePercent !== null && row.reentryPriceChangePercent !== undefined ? toNumber(row.reentryPriceChangePercent) : null,
      previousCyclePnl: row.previousCyclePnl !== null && row.previousCyclePnl !== undefined ? toNumber(row.previousCyclePnl) : null,
    };
  }

  async deleteByWalletAndToken(walletId: string, tokenId: string, sequenceNumber?: number): Promise<number> {
    const where: any = {
      walletId,
      tokenId,
    };

    if (sequenceNumber !== undefined && sequenceNumber !== null) {
      where.sequenceNumber = sequenceNumber;
    }

    const result = await prisma.closedLot.deleteMany({ where });

    return result.count;
  }

  async deleteBySellTradeId(sellTradeId: string): Promise<number> {
    const result = await prisma.closedLot.deleteMany({
      where: { sellTradeId },
    });

    return result.count;
  }

  async findByWalletId(walletId: string, tokenId?: string): Promise<ClosedLotRecord[]> {
    const where: any = { walletId };
    if (tokenId) {
      where.tokenId = tokenId;
    }

    const lots = await prisma.closedLot.findMany({
      where,
      orderBy: { exitTime: 'desc' },
    });

    return lots.map(this.mapRow);
  }

  async createMany(lots: any[]): Promise<void> {
    if (lots.length === 0) return;

    // Use createMany for better performance
    await prisma.closedLot.createMany({
      data: lots,
      skipDuplicates: true,
    });
  }
}
