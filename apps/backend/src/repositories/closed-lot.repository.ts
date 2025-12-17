import { prisma, generateId } from '../lib/prisma.js';
import { Prisma } from '@prisma/client';

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

    // NOTE:
    // - We intentionally avoid createMany here because of a Postgres binary protocol issue
    //   ("incorrect binary data format in bind parameter") when mixing Decimals and nulls.
    // - Individual creates are slower but far more robust and this path is only used
    //   during recalculations, not on every request.
    for (const lot of lots) {
      // Helper to safely convert to Decimal (only if value exists and is valid)
      const toDecimal = (value: any): Prisma.Decimal | null => {
        if (value === null || value === undefined) return null;
        if (typeof value === 'string' && value.trim() === '') return null;
        const num = typeof value === 'string' ? parseFloat(value) : Number(value);
        if (isNaN(num) || !isFinite(num)) return null;
        return new Prisma.Decimal(num);
      };

      // Helper to safely convert to number (sanitize NaN/Infinity)
      const toNumber = (value: any, defaultValue: number = 0): number => {
        if (value === null || value === undefined) return defaultValue;
        // Handle string values
        if (typeof value === 'string') {
          const trimmed = value.trim();
          if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') return defaultValue;
          const num = parseFloat(trimmed);
          if (isNaN(num) || !isFinite(num)) return defaultValue;
          return num;
        }
        // Handle number values
        const num = Number(value);
        if (isNaN(num) || !isFinite(num)) return defaultValue;
        return num;
      };

      // Helper to safely convert to nullable number
      const toNullableNumber = (value: any): number | null => {
        if (value === null || value === undefined) return null;
        const num = typeof value === 'string' ? parseFloat(value) : Number(value);
        if (isNaN(num) || !isFinite(num)) return null;
        return num;
      };

      // Convert Decimal fields to Prisma.Decimal
      // Required fields (always present)
      
      // CRITICAL: holdTimeMinutes is parameter 9 - must be a valid Float, not NaN/Infinity
      // Prisma expects Float type (not Decimal), so we need to ensure it's a proper JavaScript number
      let holdTimeMinutesValue: number;
      
      // Handle Decimal objects (from Prisma)
      if (lot.holdTimeMinutes && typeof lot.holdTimeMinutes === 'object' && 'toNumber' in lot.holdTimeMinutes) {
        holdTimeMinutesValue = (lot.holdTimeMinutes as any).toNumber();
      } else if (lot.holdTimeMinutes === null || lot.holdTimeMinutes === undefined) {
        holdTimeMinutesValue = 0;
      } else if (typeof lot.holdTimeMinutes === 'string') {
        const parsed = parseFloat(lot.holdTimeMinutes);
        holdTimeMinutesValue = isNaN(parsed) || !isFinite(parsed) ? 0 : parsed;
      } else {
        const num = Number(lot.holdTimeMinutes);
        holdTimeMinutesValue = isNaN(num) || !isFinite(num) ? 0 : num;
      }
      
      // Final validation - ensure it's a valid JavaScript number (Float)
      if (typeof holdTimeMinutesValue !== 'number' || isNaN(holdTimeMinutesValue) || !isFinite(holdTimeMinutesValue)) {
        console.error(`⚠️  Invalid holdTimeMinutes for lot ${lot.id || 'unknown'}: ${lot.holdTimeMinutes} (type: ${typeof lot.holdTimeMinutes}) -> sanitized to 0`);
        holdTimeMinutesValue = 0;
      }
      
      // CRITICAL: Prisma expects Float type, not Integer
      // Ensure it's explicitly a Float by using parseFloat (even if it's already a number)
      // This ensures Prisma's binary protocol receives it as Float, not Integer
      holdTimeMinutesValue = parseFloat(String(holdTimeMinutesValue));
      
      // Double-check it's still valid after conversion
      if (isNaN(holdTimeMinutesValue) || !isFinite(holdTimeMinutesValue)) {
        console.error(`⚠️  holdTimeMinutes became invalid after parseFloat: ${holdTimeMinutesValue} -> using 0`);
        holdTimeMinutesValue = 0;
      }
      
      const data: any = {
        id: lot.id || generateId(),
        walletId: lot.walletId,
        tokenId: lot.tokenId,
        size: toDecimal(lot.size) || new Prisma.Decimal(0),
        entryPrice: toDecimal(lot.entryPrice) || new Prisma.Decimal(0),
        exitPrice: toDecimal(lot.exitPrice) || new Prisma.Decimal(0),
        entryTime: lot.entryTime ? new Date(lot.entryTime) : new Date(),
        exitTime: lot.exitTime ? new Date(lot.exitTime) : new Date(),
        // CRITICAL: Parameter 9 - Prisma expects Float type (not Integer)
        // PostgreSQL binary protocol is strict about Float vs Integer types
        // Ensure it's explicitly a Float by using parseFloat (even for integers)
        // This ensures Prisma sends it as Float in binary protocol, not Integer
        holdTimeMinutes: parseFloat(Number(holdTimeMinutesValue).toFixed(1)),
        costBasis: toDecimal(lot.costBasis) || new Prisma.Decimal(0),
        proceeds: toDecimal(lot.proceeds) || new Prisma.Decimal(0),
        realizedPnl: toDecimal(lot.realizedPnl) || new Prisma.Decimal(0),
        realizedPnlPercent: toDecimal(lot.realizedPnlPercent) || new Prisma.Decimal(0),
        buyTradeId: lot.buyTradeId ?? null,
        sellTradeId: lot.sellTradeId ?? null,
        isPreHistory: Boolean(lot.isPreHistory ?? false),
        costKnown: Boolean(lot.costKnown ?? true),
        sequenceNumber: lot.sequenceNumber ?? null,
        // Optional Decimal fields
        realizedPnlUsd: toDecimal(lot.realizedPnlUsd),
        entryMarketCap: toDecimal(lot.entryMarketCap),
        exitMarketCap: toDecimal(lot.exitMarketCap),
        entryLiquidity: toDecimal(lot.entryLiquidity),
        exitLiquidity: toDecimal(lot.exitLiquidity),
        entryVolume24h: toDecimal(lot.entryVolume24h),
        exitVolume24h: toDecimal(lot.exitVolume24h),
        maxProfitPercent: toDecimal(lot.maxProfitPercent),
        maxDrawdownPercent: toDecimal(lot.maxDrawdownPercent),
        reentryPriceChangePercent: toDecimal(lot.reentryPriceChangePercent),
        previousCyclePnl: toDecimal(lot.previousCyclePnl),
        // Optional Float/Int fields (not Decimal) - sanitize NaN/Infinity
        entryHourOfDay: toNullableNumber(lot.entryHourOfDay),
        entryDayOfWeek: toNullableNumber(lot.entryDayOfWeek),
        exitHourOfDay: toNullableNumber(lot.exitHourOfDay),
        exitDayOfWeek: toNullableNumber(lot.exitDayOfWeek),
        tokenAgeAtEntryMinutes: toNullableNumber(lot.tokenAgeAtEntryMinutes),
        exitReason: lot.exitReason ?? null,
        timeToMaxProfitMinutes: toNullableNumber(lot.timeToMaxProfitMinutes),
        dcaEntryCount: toNullableNumber(lot.dcaEntryCount),
        dcaTimeSpanMinutes: toNullableNumber(lot.dcaTimeSpanMinutes),
        reentryTimeMinutes: toNullableNumber(lot.reentryTimeMinutes),
      };
      
      // Log the value before creating (for debugging parameter 9 issue)
      if (typeof holdTimeMinutesValue !== 'number' || isNaN(holdTimeMinutesValue) || !isFinite(holdTimeMinutesValue)) {
        console.error(`❌ CRITICAL: holdTimeMinutes is invalid before create: ${holdTimeMinutesValue} (type: ${typeof holdTimeMinutesValue})`);
      }
      
      try {
        await prisma.closedLot.create({
          data,
        });
      } catch (error: any) {
        // Log the problematic data for debugging
        console.error(`❌ Failed to create ClosedLot for wallet ${lot.walletId?.substring(0, 8)}... token ${lot.tokenId?.substring(0, 8)}...`);
        console.error(`   holdTimeMinutes (param 9): ${holdTimeMinutesValue} (type: ${typeof holdTimeMinutesValue}, original: ${lot.holdTimeMinutes})`);
        console.error(`   entryTime: ${data.entryTime}, exitTime: ${data.exitTime}`);
        console.error(`   Error: ${error.message}`);
        if (error.message?.includes('bind parameter 9')) {
          console.error(`   ⚠️  Parameter 9 (holdTimeMinutes) issue detected!`);
          console.error(`   Raw value: ${JSON.stringify(lot.holdTimeMinutes)}`);
          console.error(`   Converted value: ${holdTimeMinutesValue}`);
          console.error(`   Is NaN: ${isNaN(holdTimeMinutesValue)}`);
          console.error(`   Is Finite: ${isFinite(holdTimeMinutesValue)}`);
        }
        throw error; // Re-throw to maintain error propagation
      }
    }
  }
}
