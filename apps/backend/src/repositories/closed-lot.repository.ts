import { supabase, TABLES } from '../lib/supabase.js';

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
  realizedPnlUsd: number | null; // USD value at time of closure (fixed, doesn't change with SOL price)
  buyTradeId: string | null;
  sellTradeId: string | null;
  isPreHistory: boolean;
  costKnown: boolean;
  sequenceNumber: number | null; // Kolikátý BUY-SELL cyklus pro tento token (1., 2., 3. atd.)
  
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
      let query = supabase
        .from(TABLES.CLOSED_LOT)
        .select('*')
        .eq('walletId', walletId)
        .order('exitTime', { ascending: false });

      if (options?.fromDate) {
        query = query.gte('exitTime', options.fromDate.toISOString());
      }

      if (options?.toDate) {
        query = query.lte('exitTime', options.toDate.toISOString());
      }

      const { data, error } = await query;

      if (error) {
        // Table might not exist yet
        if (error.code === '42P01' || /does not exist/i.test(error.message)) {
          console.warn('⚠️  ClosedLot table does not exist. Run ADD_CLOSED_LOTS.sql migration.');
          return [];
        }
        throw new Error(`Failed to fetch closed lots: ${error.message}`);
      }

      return (data ?? []).map(this.mapRow);
    })();
    
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Closed lots fetch timeout')), FETCH_TIMEOUT_MS)
    );
    
    try {
      return await Promise.race([fetchPromise, timeoutPromise]) as ClosedLotRecord[];
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
    let query = supabase
      .from(TABLES.CLOSED_LOT)
      .delete()
      .eq('walletId', walletId)
      .eq('tokenId', tokenId)
      .select('id');

    if (sequenceNumber !== undefined && sequenceNumber !== null) {
      query = query.eq('sequenceNumber', sequenceNumber);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to delete closed lots: ${error.message}`);
    }

    return data?.length || 0;
  }

  async deleteBySellTradeId(sellTradeId: string): Promise<number> {
    const { data, error } = await supabase
      .from(TABLES.CLOSED_LOT)
      .delete()
      .eq('sellTradeId', sellTradeId)
      .select('id');

    if (error) {
      throw new Error(`Failed to delete closed lots: ${error.message}`);
    }

    return data?.length || 0;
  }
}



