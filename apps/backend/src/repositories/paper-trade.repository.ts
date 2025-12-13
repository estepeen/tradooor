import { supabase, TABLES } from '../lib/supabase.js';

export interface PaperTradeRecord {
  id: string;
  walletId: string;
  tokenId: string;
  originalTradeId: string | null;
  side: 'buy' | 'sell';
  amountToken: number;
  amountBase: number;
  priceBasePerToken: number;
  timestamp: Date;
  status: 'open' | 'closed' | 'cancelled';
  realizedPnl: number | null;
  realizedPnlPercent: number | null;
  closedAt: Date | null;
  meta: Record<string, any> | null;
}

export interface PaperPortfolioRecord {
  id: string;
  timestamp: Date;
  totalValueUsd: number;
  totalCostUsd: number;
  totalPnlUsd: number;
  totalPnlPercent: number;
  openPositions: number;
  closedPositions: number;
  winRate: number | null;
  totalTrades: number;
  meta: Record<string, any> | null;
}

const toNumber = (value: any) => (value === null || value === undefined ? 0 : Number(value));

export class PaperTradeRepository {
  async create(data: {
    walletId: string;
    tokenId: string;
    originalTradeId?: string | null;
    side: 'buy' | 'sell';
    amountToken: number;
    amountBase: number;
    priceBasePerToken: number;
    timestamp?: Date;
    status?: 'open' | 'closed' | 'cancelled';
    realizedPnl?: number | null;
    realizedPnlPercent?: number | null;
    closedAt?: Date | null;
    meta?: Record<string, any> | null;
  }): Promise<PaperTradeRecord> {
    const id = `pt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    
    const payload = {
      id,
      walletId: data.walletId,
      tokenId: data.tokenId,
      originalTradeId: data.originalTradeId ?? null,
      side: data.side,
      amountToken: data.amountToken.toString(),
      amountBase: data.amountBase.toString(),
      priceBasePerToken: data.priceBasePerToken.toString(),
      timestamp: (data.timestamp || new Date()).toISOString(),
      status: data.status || 'open',
      realizedPnl: data.realizedPnl?.toString() ?? null,
      realizedPnlPercent: data.realizedPnlPercent?.toString() ?? null,
      closedAt: data.closedAt?.toISOString() ?? null,
      meta: data.meta ?? null,
    };

    const { data: result, error } = await supabase
      .from('PaperTrade')
      .insert(payload)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create paper trade: ${error.message}`);
    }

    return this.mapRow(result);
  }

  async findById(id: string): Promise<PaperTradeRecord | null> {
    const { data, error } = await supabase
      .from('PaperTrade')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // Not found
      throw new Error(`Failed to find paper trade: ${error.message}`);
    }

    return data ? this.mapRow(data) : null;
  }

  async findByWallet(walletId: string, options?: {
    status?: 'open' | 'closed' | 'cancelled';
    limit?: number;
    orderBy?: 'timestamp' | 'closedAt';
    orderDirection?: 'asc' | 'desc';
  }): Promise<PaperTradeRecord[]> {
    let query = supabase
      .from('PaperTrade')
      .select('*')
      .eq('walletId', walletId);

    if (options?.status) {
      query = query.eq('status', options.status);
    }

    const orderBy = options?.orderBy || 'timestamp';
    const orderDirection = options?.orderDirection || 'desc';
    query = query.order(orderBy, { ascending: orderDirection === 'asc' });

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    const { data: result, error: queryError } = await query;

    if (queryError) {
      throw new Error(`Failed to find paper trades: ${queryError.message}`);
    }

    return (result || []).map(row => this.mapRow(row));
  }

  async findOpenPositions(walletId?: string): Promise<PaperTradeRecord[]> {
    let query = supabase
      .from('PaperTrade')
      .select('*')
      .eq('status', 'open');

    if (walletId) {
      query = query.eq('walletId', walletId);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to find open positions: ${error.message}`);
    }

    return (data || []).map(row => this.mapRow(row));
  }

  async update(id: string, data: Partial<{
    status: 'open' | 'closed' | 'cancelled';
    realizedPnl: number | null;
    realizedPnlPercent: number | null;
    closedAt: Date | null;
    meta: Record<string, any> | null;
  }>): Promise<PaperTradeRecord> {
    const payload: any = {};

    if (data.status !== undefined) payload.status = data.status;
    if (data.realizedPnl !== undefined) payload.realizedPnl = data.realizedPnl?.toString() ?? null;
    if (data.realizedPnlPercent !== undefined) payload.realizedPnlPercent = data.realizedPnlPercent?.toString() ?? null;
    if (data.closedAt !== undefined) payload.closedAt = data.closedAt?.toISOString() ?? null;
    if (data.meta !== undefined) payload.meta = data.meta;

    const { data: result, error } = await supabase
      .from('PaperTrade')
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update paper trade: ${error.message}`);
    }

    return this.mapRow(result);
  }

  async getPortfolioStats(): Promise<{
    totalValueUsd: number;
    totalCostUsd: number;
    totalPnlUsd: number;
    totalPnlPercent: number;
    openPositions: number;
    closedPositions: number;
    winRate: number | null;
    totalTrades: number;
  }> {
    // Get all open positions
    const openPositions = await this.findOpenPositions();
    
    // Get all closed positions
    const { data: closedData, error: closedError } = await supabase
      .from('PaperTrade')
      .select('realizedPnl, realizedPnlPercent')
      .eq('status', 'closed');

    if (closedError) {
      throw new Error(`Failed to get closed positions: ${closedError.message}`);
    }

    const closedPositions = closedData || [];
    const totalTrades = openPositions.length + closedPositions.length;
    
    // Calculate total cost (sum of all buy amounts)
    const totalCostUsd = openPositions.reduce((sum, pos) => {
      return sum + (pos.side === 'buy' ? pos.amountBase : 0);
    }, 0);

    // Calculate total value (current value of open positions + realized PnL from closed)
    const totalRealizedPnl = closedPositions.reduce((sum, pos) => {
      return sum + (toNumber(pos.realizedPnl) || 0);
    }, 0);

    // For open positions, we'd need current token prices to calculate current value
    // For now, we'll use entry value (amountBase)
    const openPositionsValue = openPositions.reduce((sum, pos) => {
      return sum + (pos.side === 'buy' ? pos.amountBase : 0);
    }, 0);

    const totalValueUsd = openPositionsValue + totalRealizedPnl;
    const totalPnlUsd = totalValueUsd - totalCostUsd;
    const totalPnlPercent = totalCostUsd > 0 ? (totalPnlUsd / totalCostUsd) * 100 : 0;

    // Calculate win rate
    const winningTrades = closedPositions.filter(pos => (toNumber(pos.realizedPnl) || 0) > 0).length;
    const winRate = closedPositions.length > 0 ? winningTrades / closedPositions.length : null;

    return {
      totalValueUsd,
      totalCostUsd,
      totalPnlUsd,
      totalPnlPercent,
      openPositions: openPositions.length,
      closedPositions: closedPositions.length,
      winRate,
      totalTrades,
    };
  }

  async createPortfolioSnapshot(stats: {
    totalValueUsd: number;
    totalCostUsd: number;
    totalPnlUsd: number;
    totalPnlPercent: number;
    openPositions: number;
    closedPositions: number;
    winRate: number | null;
    totalTrades: number;
  }): Promise<PaperPortfolioRecord> {
    const id = `pp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const payload = {
      id,
      timestamp: new Date().toISOString(),
      totalValueUsd: stats.totalValueUsd.toString(),
      totalCostUsd: stats.totalCostUsd.toString(),
      totalPnlUsd: stats.totalPnlUsd.toString(),
      totalPnlPercent: stats.totalPnlPercent.toString(),
      openPositions: stats.openPositions,
      closedPositions: stats.closedPositions,
      winRate: stats.winRate?.toString() ?? null,
      totalTrades: stats.totalTrades,
      meta: null,
    };

    const { data, error } = await supabase
      .from('PaperPortfolio')
      .insert(payload)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create portfolio snapshot: ${error.message}`);
    }

    return this.mapPortfolioRow(data);
  }

  private mapRow(row: any): PaperTradeRecord {
    return {
      id: row.id,
      walletId: row.walletId,
      tokenId: row.tokenId,
      originalTradeId: row.originalTradeId ?? null,
      side: row.side,
      amountToken: toNumber(row.amountToken),
      amountBase: toNumber(row.amountBase),
      priceBasePerToken: toNumber(row.priceBasePerToken),
      timestamp: new Date(row.timestamp),
      status: row.status,
      realizedPnl: row.realizedPnl ? toNumber(row.realizedPnl) : null,
      realizedPnlPercent: row.realizedPnlPercent ? toNumber(row.realizedPnlPercent) : null,
      closedAt: row.closedAt ? new Date(row.closedAt) : null,
      meta: row.meta,
    };
  }

  private mapPortfolioRow(row: any): PaperPortfolioRecord {
    return {
      id: row.id,
      timestamp: new Date(row.timestamp),
      totalValueUsd: toNumber(row.totalValueUsd),
      totalCostUsd: toNumber(row.totalCostUsd),
      totalPnlUsd: toNumber(row.totalPnlUsd),
      totalPnlPercent: toNumber(row.totalPnlPercent),
      openPositions: row.openPositions,
      closedPositions: row.closedPositions,
      winRate: row.winRate ? toNumber(row.winRate) : null,
      totalTrades: row.totalTrades,
      meta: row.meta,
    };
  }
}
