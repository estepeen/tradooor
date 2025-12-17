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
      // PostgreSQL binary protocol is strict about Float vs Integer types
      // Even for 0 or whole numbers, we need to ensure it's sent as Float (0.0, 1.0) not Integer (0, 1)
      // Force it to be a Float by ensuring it has a decimal part
      // Convert to string with .0 if it's a whole number, then parse back as float
      const originalValue = holdTimeMinutesValue;
      
      // CRITICAL: Always ensure it has a decimal part to force Float type
      // Use toFixed(1) to ensure at least one decimal place, then parseFloat to get back to number
      // This ensures JavaScript treats it as Float, not Integer
      holdTimeMinutesValue = Number.parseFloat(holdTimeMinutesValue.toFixed(1));
      
      // Double-check it's still valid after conversion
      if (isNaN(holdTimeMinutesValue) || !isFinite(holdTimeMinutesValue)) {
        console.error(`⚠️  holdTimeMinutes became invalid after conversion: ${holdTimeMinutesValue} -> using 0.0`);
        holdTimeMinutesValue = 0.0; // Explicit Float, not Integer
      }
      
      // Log conversion details for debugging (only if changed or if it was an integer)
      if (originalValue !== holdTimeMinutesValue || Number.isInteger(originalValue)) {
        console.log(`🔍 holdTimeMinutes conversion: ${originalValue} (${typeof originalValue}, isInteger: ${Number.isInteger(originalValue)}) -> ${holdTimeMinutesValue} (${typeof holdTimeMinutesValue}, isInteger: ${Number.isInteger(holdTimeMinutesValue)})`);
      }
      
      // Validate that buyTradeId and sellTradeId reference existing Trade records
      // NOTE: sellTradeId is NOT NULL in database, so we must provide a valid Trade ID or create a placeholder
      let buyTradeId = lot.buyTradeId ?? null;
      // CRITICAL: sellTradeId is NOT NULL - initialize immediately to prevent NULL
      let sellTradeId: string = lot.sellTradeId || `synthetic-${generateId()}`;
      
      // Check if Trade records exist (only if IDs are provided)
      if (buyTradeId) {
        try {
          const tradeExists = await prisma.trade.findUnique({ where: { id: buyTradeId }, select: { id: true } });
          if (!tradeExists) {
            console.warn(`⚠️  buyTradeId ${buyTradeId} does not exist in Trade table, setting to NULL`);
            buyTradeId = null;
          }
        } catch (error) {
          // If check fails, set to NULL to be safe
          console.warn(`⚠️  Failed to verify buyTradeId ${buyTradeId}, setting to NULL:`, error);
          buyTradeId = null;
        }
      }
      
      // CRITICAL: sellTradeId is NOT NULL in database (position 15) and has foreign key constraint
      // We MUST provide a valid Trade ID that exists in Trade table
      // If not provided or Trade doesn't exist, create a placeholder Trade or use existing one
      if (!sellTradeId || sellTradeId.trim() === '') {
        // sellTradeId is required but not provided - try to find any existing Trade for this wallet/token
        try {
          const existingTrade = await prisma.trade.findFirst({
            where: {
              walletId: lot.walletId,
              tokenId: lot.tokenId,
              side: 'sell',
            },
            orderBy: { timestamp: 'desc' },
            select: { id: true },
          });
          
          if (existingTrade) {
            sellTradeId = existingTrade.id;
            console.warn(`⚠️  sellTradeId was not provided, using existing Trade: ${sellTradeId}`);
          } else {
            // No existing Trade found - create a placeholder Trade
            sellTradeId = `synthetic-${generateId()}`;
            console.warn(`⚠️  sellTradeId was not provided and no existing Trade found, will create placeholder: ${sellTradeId}`);
          }
        } catch (error) {
          // If check fails, generate placeholder
          sellTradeId = `synthetic-${generateId()}`;
          console.warn(`⚠️  Failed to find existing Trade, generated placeholder: ${sellTradeId}`, error);
        }
      } else {
        // Check if Trade exists
        try {
          const tradeExists = await prisma.trade.findUnique({ where: { id: sellTradeId }, select: { id: true } });
          if (!tradeExists) {
            // Trade doesn't exist - try to find existing Trade or create placeholder
            try {
              const existingTrade = await prisma.trade.findFirst({
                where: {
                  walletId: lot.walletId,
                  tokenId: lot.tokenId,
                  side: 'sell',
                },
                orderBy: { timestamp: 'desc' },
                select: { id: true },
              });
              
              if (existingTrade) {
                sellTradeId = existingTrade.id;
                console.warn(`⚠️  sellTradeId ${sellTradeId} does not exist, using existing Trade: ${sellTradeId}`);
              } else {
                // Keep original ID - we'll create placeholder Trade below
                console.warn(`⚠️  sellTradeId ${sellTradeId} does not exist, will create placeholder Trade`);
              }
            } catch (error) {
              console.warn(`⚠️  Failed to find existing Trade, keeping original sellTradeId: ${sellTradeId}`, error);
            }
          }
        } catch (error) {
          // If check fails, keep the original ID
          console.warn(`⚠️  Failed to verify sellTradeId ${sellTradeId}, keeping original:`, error);
        }
      }
      
      // Final check - ensure sellTradeId is never null or empty
      if (!sellTradeId || sellTradeId.trim() === '') {
        sellTradeId = `synthetic-${generateId()}`;
        console.error(`❌ CRITICAL: sellTradeId was still null/empty after processing, generated: ${sellTradeId}`);
      }
      
      // If sellTradeId is a synthetic ID or doesn't exist, create a placeholder Trade to satisfy foreign key constraint
      // First, check if Trade exists
      let tradeExists = false;
      try {
        const trade = await prisma.trade.findUnique({ where: { id: sellTradeId }, select: { id: true } });
        tradeExists = !!trade;
      } catch (error) {
        console.warn(`⚠️  Failed to check if Trade exists: ${sellTradeId}`, error);
      }
      
      if (!tradeExists) {
        // Trade doesn't exist - create placeholder or use existing
        if (sellTradeId.startsWith('synthetic-')) {
          // Try to create placeholder Trade
          try {
            const txSignature = `synthetic-${sellTradeId}-${Date.now()}`; // Ensure uniqueness
            await prisma.trade.create({
              data: {
                id: sellTradeId,
                txSignature: txSignature,
                walletId: lot.walletId,
                tokenId: lot.tokenId,
                side: 'sell',
                amountToken: new Prisma.Decimal(0),
                amountBase: new Prisma.Decimal(0),
                priceBasePerToken: new Prisma.Decimal(0),
                timestamp: lot.exitTime || new Date(),
                dex: 'synthetic',
                meta: { synthetic: true, reason: 'placeholder_for_closed_lot' },
              },
            });
            console.log(`✅ Created placeholder Trade: ${sellTradeId} with txSignature: ${txSignature}`);
          } catch (error: any) {
            // If creation fails (e.g., duplicate txSignature), try to use existing Trade
            console.warn(`⚠️  Failed to create placeholder Trade ${sellTradeId}:`, error.message);
            try {
              const existingTrade = await prisma.trade.findFirst({
                where: {
                  walletId: lot.walletId,
                  tokenId: lot.tokenId,
                },
                orderBy: { timestamp: 'desc' },
                select: { id: true },
              });
              if (existingTrade) {
                sellTradeId = existingTrade.id;
                console.warn(`⚠️  Using existing Trade instead: ${sellTradeId}`);
              } else {
                console.error(`❌ No existing Trade found and failed to create placeholder, will fail with foreign key constraint`);
              }
            } catch (findError) {
              console.error(`❌ Failed to find alternative Trade:`, findError);
            }
          }
        } else {
          // sellTradeId is not synthetic but doesn't exist - try to find existing Trade
          try {
            const existingTrade = await prisma.trade.findFirst({
              where: {
                walletId: lot.walletId,
                tokenId: lot.tokenId,
              },
              orderBy: { timestamp: 'desc' },
              select: { id: true },
            });
            if (existingTrade) {
              sellTradeId = existingTrade.id;
              console.warn(`⚠️  sellTradeId ${lot.sellTradeId} does not exist, using existing Trade: ${sellTradeId}`);
            } else {
              // No existing Trade found - create synthetic one
              sellTradeId = `synthetic-${generateId()}`;
              console.warn(`⚠️  No existing Trade found, creating synthetic: ${sellTradeId}`);
              try {
                const txSignature = `synthetic-${sellTradeId}-${Date.now()}`;
                await prisma.trade.create({
                  data: {
                    id: sellTradeId,
                    txSignature: txSignature,
                    walletId: lot.walletId,
                    tokenId: lot.tokenId,
                    side: 'sell',
                    amountToken: new Prisma.Decimal(0),
                    amountBase: new Prisma.Decimal(0),
                    priceBasePerToken: new Prisma.Decimal(0),
                    timestamp: lot.exitTime || new Date(),
                    dex: 'synthetic',
                    meta: { synthetic: true, reason: 'placeholder_for_closed_lot' },
                  },
                });
                console.log(`✅ Created placeholder Trade: ${sellTradeId}`);
              } catch (createError: any) {
                console.error(`❌ Failed to create placeholder Trade:`, createError.message);
              }
            }
          } catch (findError) {
            console.error(`❌ Failed to find alternative Trade:`, findError);
          }
        }
      }
      
      // Final verification: ensure sellTradeId exists in Trade table before INSERT
      try {
        const finalTradeCheck = await prisma.trade.findUnique({ where: { id: sellTradeId }, select: { id: true } });
        if (!finalTradeCheck) {
          console.error(`❌ CRITICAL: sellTradeId ${sellTradeId} does not exist in Trade table before INSERT!`);
          console.error(`   walletId: ${lot.walletId}, tokenId: ${lot.tokenId}`);
          console.error(`   This will cause foreign key constraint violation.`);
          // Try one more time to create or find Trade
          try {
            const lastResortTrade = await prisma.trade.findFirst({
              where: { walletId: lot.walletId, tokenId: lot.tokenId },
              orderBy: { timestamp: 'desc' },
              select: { id: true },
            });
            if (lastResortTrade) {
              sellTradeId = lastResortTrade.id;
              console.warn(`⚠️  Using last resort Trade: ${sellTradeId}`);
            } else {
              // Create placeholder as absolute last resort
              const lastResortId = `synthetic-${generateId()}`;
              const txSignature = `synthetic-${lastResortId}-${Date.now()}-${Math.random()}`;
              try {
                await prisma.trade.create({
                  data: {
                    id: lastResortId,
                    txSignature: txSignature,
                    walletId: lot.walletId,
                    tokenId: lot.tokenId,
                    side: 'sell',
                    amountToken: new Prisma.Decimal(0),
                    amountBase: new Prisma.Decimal(0),
                    priceBasePerToken: new Prisma.Decimal(0),
                    timestamp: lot.exitTime || new Date(),
                    dex: 'synthetic',
                    meta: { synthetic: true, reason: 'last_resort_placeholder' },
                  },
                });
                sellTradeId = lastResortId;
                console.warn(`⚠️  Created last resort placeholder Trade: ${sellTradeId}`);
              } catch (createError: any) {
                console.error(`❌ Failed to create last resort Trade:`, createError.message);
                throw new Error(`Cannot create ClosedLot: sellTradeId ${sellTradeId} does not exist and cannot be created`);
              }
            }
          } catch (error) {
            console.error(`❌ Failed last resort Trade lookup/creation:`, error);
            throw new Error(`Cannot create ClosedLot: sellTradeId ${sellTradeId} does not exist`);
          }
        } else {
          console.log(`✅ Verified sellTradeId ${sellTradeId} exists in Trade table`);
        }
      } catch (error) {
        console.error(`❌ Failed to verify sellTradeId before INSERT:`, error);
        throw error;
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
        // Ensure it's explicitly a Float by ensuring it has decimal part
        // Even 0 must be 0.0 to be sent as Float in binary protocol
        // Value is already converted to Float with toFixed(1) above
        holdTimeMinutes: holdTimeMinutesValue,
        costBasis: toDecimal(lot.costBasis) || new Prisma.Decimal(0),
        proceeds: toDecimal(lot.proceeds) || new Prisma.Decimal(0),
        realizedPnl: toDecimal(lot.realizedPnl) || new Prisma.Decimal(0),
        realizedPnlPercent: toDecimal(lot.realizedPnlPercent) || new Prisma.Decimal(0),
        buyTradeId: buyTradeId,
        sellTradeId: sellTradeId,
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
      
      // CRITICAL FIX: Use raw SQL directly because Prisma create() always fails with binary protocol error
      // Prisma's binary protocol incorrectly sends whole numbers as Integer instead of Float
      // Using $executeRawUnsafe with explicit ::double precision cast ensures it's always sent as Float
      // Helper functions to safely format values for SQL
      const sqlValue = (value: any): string => {
        if (value === null || value === undefined) return 'NULL';
        if (typeof value === 'boolean') return value ? 'true' : 'false';
        if (value instanceof Date) return `'${value.toISOString()}'`;
        if (typeof value === 'string') {
          // Escape single quotes
          return `'${value.replace(/'/g, "''")}'`;
        }
        if (value instanceof Prisma.Decimal) return value.toString();
        return String(value);
      };
      
      try {
        // Build SQL with explicit cast for holdTimeMinutes - ensure it's always a float
        const holdTimeMinutesSql = `${holdTimeMinutesValue}::double precision`;
        
        // Use raw SQL with all columns including createdAt and updatedAt
        // Prisma will handle createdAt and updatedAt automatically, but we need to include them in raw SQL
        const now = new Date();
        const createdAt = now.toISOString();
        const updatedAt = now.toISOString();
        
        // CRITICAL: Column order must match database order exactly!
        // Database order: id, walletId, tokenId, size, entryPrice, exitPrice, entryTime, exitTime,
        // holdTimeMinutes, costBasis, proceeds, realizedPnl, realizedPnlPercent, buyTradeId, sellTradeId,
        // isPreHistory, costKnown, createdAt, updatedAt, realizedPnlUsd, sequenceNumber, ...
        const sql = `
          INSERT INTO "ClosedLot" (
            "id","walletId","tokenId","size","entryPrice","exitPrice",
            "entryTime","exitTime","holdTimeMinutes","costBasis","proceeds",
            "realizedPnl","realizedPnlPercent",
            "buyTradeId","sellTradeId","isPreHistory","costKnown",
            "createdAt","updatedAt",
            "realizedPnlUsd",
            "sequenceNumber","entryHourOfDay","entryDayOfWeek","exitHourOfDay","exitDayOfWeek",
            "entryMarketCap","exitMarketCap","entryLiquidity","exitLiquidity",
            "entryVolume24h","exitVolume24h","tokenAgeAtEntryMinutes",
            "exitReason","maxProfitPercent","maxDrawdownPercent","timeToMaxProfitMinutes",
            "dcaEntryCount","dcaTimeSpanMinutes","reentryTimeMinutes","reentryPriceChangePercent","previousCyclePnl"
          ) VALUES (
            ${sqlValue(data.id)}, ${sqlValue(data.walletId)}, ${sqlValue(data.tokenId)}, ${sqlValue(data.size)}, ${sqlValue(data.entryPrice)}, ${sqlValue(data.exitPrice)},
            ${sqlValue(data.entryTime)}, ${sqlValue(data.exitTime)}, ${holdTimeMinutesSql}, ${sqlValue(data.costBasis)}, ${sqlValue(data.proceeds)},
            ${sqlValue(data.realizedPnl)}, ${sqlValue(data.realizedPnlPercent)},
            ${sqlValue(buyTradeId)}, ${sqlValue(sellTradeId)}, ${sqlValue(data.isPreHistory)}, ${sqlValue(data.costKnown)},
            '${createdAt}', '${updatedAt}',
            ${sqlValue(data.realizedPnlUsd)},
            ${sqlValue(data.sequenceNumber)}, ${sqlValue(data.entryHourOfDay)}, ${sqlValue(data.entryDayOfWeek)}, ${sqlValue(data.exitHourOfDay)}, ${sqlValue(data.exitDayOfWeek)},
            ${sqlValue(data.entryMarketCap)}, ${sqlValue(data.exitMarketCap)}, ${sqlValue(data.entryLiquidity)}, ${sqlValue(data.exitLiquidity)},
            ${sqlValue(data.entryVolume24h)}, ${sqlValue(data.exitVolume24h)}, ${sqlValue(data.tokenAgeAtEntryMinutes)},
            ${sqlValue(data.exitReason)}, ${sqlValue(data.maxProfitPercent)}, ${sqlValue(data.maxDrawdownPercent)}, ${sqlValue(data.timeToMaxProfitMinutes)},
            ${sqlValue(data.dcaEntryCount)}, ${sqlValue(data.dcaTimeSpanMinutes)}, ${sqlValue(data.reentryTimeMinutes)}, ${sqlValue(data.reentryPriceChangePercent)}, ${sqlValue(data.previousCyclePnl)}
          )
        `;
        await prisma.$executeRawUnsafe(sql);
      } catch (error: any) {
        // Log the problematic data for debugging
        console.error(`❌ Failed to create ClosedLot for wallet ${lot.walletId?.substring(0, 8)}... token ${lot.tokenId?.substring(0, 8)}...`);
        console.error(`   holdTimeMinutes (param 9): ${holdTimeMinutesValue} (type: ${typeof holdTimeMinutesValue}, original: ${lot.holdTimeMinutes})`);
        console.error(`   entryTime: ${data.entryTime}, exitTime: ${data.exitTime}`);
        console.error(`   Error: ${error.message}`);
        console.error(`   Error code: ${error.code}`);
        
        // If it's a not null violation, try to identify which column is NULL
        if (error?.code === '23502' || error?.message?.includes('23502')) {
          // Check all required fields
          const requiredFields = {
            id: data.id,
            walletId: data.walletId,
            tokenId: data.tokenId,
            size: data.size,
            entryPrice: data.entryPrice,
            exitPrice: data.exitPrice,
            entryTime: data.entryTime,
            exitTime: data.exitTime,
            holdTimeMinutes: holdTimeMinutesValue,
            costBasis: data.costBasis,
            proceeds: data.proceeds,
            realizedPnl: data.realizedPnl,
            realizedPnlPercent: data.realizedPnlPercent,
            isPreHistory: data.isPreHistory,
            costKnown: data.costKnown,
          };
          
          const nullFields = Object.entries(requiredFields)
            .filter(([key, value]) => value === null || value === undefined)
            .map(([key]) => key);
          
          if (nullFields.length > 0) {
            console.error(`   ⚠️  NULL required fields detected: ${nullFields.join(', ')}`);
          }
        }
        
        throw error; // Re-throw to maintain error propagation
      }
    }
  }
}
