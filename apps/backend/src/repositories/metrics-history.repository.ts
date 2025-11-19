import { supabase, TABLES, generateId } from '../lib/supabase.js';

export class MetricsHistoryRepository {
  async create(data: {
    walletId: string;
    timestamp: Date;
    score: number;
    totalTrades: number;
    winRate: number;
    avgRr: number;
    avgPnlPercent: number;
    pnlTotalBase: number;
    avgHoldingTimeMin: number;
    maxDrawdownPercent: number;
    recentPnl30dPercent: number;
  }) {
    const { data: result, error } = await supabase
      .from(TABLES.SMART_WALLET_METRICS_HISTORY)
      .insert({
        id: generateId(),
        walletId: data.walletId,
        timestamp: data.timestamp.toISOString(),
        score: data.score,
        totalTrades: data.totalTrades,
        winRate: data.winRate,
        avgRr: data.avgRr,
        avgPnlPercent: data.avgPnlPercent,
        pnlTotalBase: data.pnlTotalBase,
        avgHoldingTimeMin: data.avgHoldingTimeMin,
        maxDrawdownPercent: data.maxDrawdownPercent,
        recentPnl30dPercent: data.recentPnl30dPercent,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create metrics history: ${error.message}`);
    }

    return result;
  }

  async findByWalletId(walletId: string, fromDate?: Date) {
    let query = supabase
      .from(TABLES.SMART_WALLET_METRICS_HISTORY)
      .select('*')
      .eq('walletId', walletId);

    if (fromDate) {
      query = query.gte('timestamp', fromDate.toISOString());
    }

    query = query.order('timestamp', { ascending: true });

    const { data: history, error } = await query;

    if (error) {
      throw new Error(`Failed to fetch metrics history: ${error.message}`);
    }

    return history ?? [];
  }
}
