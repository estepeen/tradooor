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
}

export class ClosedLotRepository {
  async findByWallet(walletId: string, options?: { fromDate?: Date; toDate?: Date }) {
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
    };
  }
}



