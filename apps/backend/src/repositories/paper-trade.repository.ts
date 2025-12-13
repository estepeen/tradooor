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
    try {
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
        // Table might not exist yet
        if (queryError.code === '42P01' || /does not exist/i.test(queryError.message)) {
          console.warn('⚠️  PaperTrade table does not exist yet. Run ADD_PAPER_TRADING.sql migration.');
          return [];
        }
        throw new Error(`Failed to find paper trades: ${queryError.message}`);
      }

      return (result || []).map(row => this.mapRow(row));
    } catch (error: any) {
      if (error.message?.includes('does not exist') || error.message?.includes('42P01')) {
        return [];
      }
      throw error;
    }
  }

  async findOpenPositions(walletId?: string): Promise<PaperTradeRecord[]> {
    try {
      let query = supabase
        .from('PaperTrade')
        .select('*')
        .eq('status', 'open');

      if (walletId) {
        query = query.eq('walletId', walletId);
      }

      const { data, error } = await query;

      if (error) {
        // Table might not exist yet
        if (error.code === '42P01' || /does not exist/i.test(error.message)) {
          console.warn('⚠️  PaperTrade table does not exist yet. Run ADD_PAPER_TRADING.sql migration.');
          return [];
        }
        throw new Error(`Failed to find open positions: ${error.message}`);
      }

      return (data || []).map(row => this.mapRow(row));
    } catch (error: any) {
      if (error.message?.includes('does not exist') || error.message?.includes('42P01')) {
        return [];
      }
      throw error;
    }
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
    initialCapital: number;
    byModel?: {
      'smart-copy': {
        totalTrades: number;
        openPositions: number;
        closedPositions: number;
        totalPnlUsd: number;
        totalPnlPercent: number;
        winRate: number | null;
        totalCostUsd: number;
      };
      'consensus': {
        totalTrades: number;
        openPositions: number;
        closedPositions: number;
        totalPnlUsd: number;
        totalPnlPercent: number;
        winRate: number | null;
        totalCostUsd: number;
      };
    };
  }> {
    const INITIAL_CAPITAL_USD = 1000;
    
    try {
      // Get all open positions
      const openPositions = await this.findOpenPositions();
      
      // Get all closed positions
      const { data: closedData, error: closedError } = await supabase
        .from('PaperTrade')
        .select('realizedPnl, realizedPnlPercent')
        .eq('status', 'closed');

      if (closedError) {
        // Table might not exist yet - return default values
        if (closedError.code === '42P01' || /does not exist/i.test(closedError.message)) {
          console.warn('⚠️  PaperTrade table does not exist yet. Run ADD_PAPER_TRADING.sql migration.');
          return {
            totalValueUsd: INITIAL_CAPITAL_USD,
            totalCostUsd: 0,
            totalPnlUsd: 0,
            totalPnlPercent: 0,
            openPositions: 0,
            closedPositions: 0,
            winRate: null,
            totalTrades: 0,
            initialCapital: INITIAL_CAPITAL_USD,
          };
        }
        throw new Error(`Failed to get closed positions: ${closedError.message}`);
      }

      const closedPositions = closedData || [];
      const totalTrades = openPositions.length + closedPositions.length;
      
      // Calculate total cost (sum of all buy amounts for open + closed)
      const openCost = openPositions.reduce((sum, pos) => {
        return sum + (pos.side === 'buy' ? pos.amountBase : 0);
      }, 0);

      // For closed positions, we need to get the original cost
      const { data: closedTradesData } = await supabase
        .from('PaperTrade')
        .select('amountBase')
        .eq('status', 'closed')
        .eq('side', 'buy');

      const closedCost = (closedTradesData || []).reduce((sum, pos) => {
        return sum + toNumber(pos.amountBase);
      }, 0);

      const totalCostUsd = openCost + closedCost;

      // Calculate total REALIZED PnL (only from closed positions)
      // DŮLEŽITÉ: Počítáme jen realizované PnL z uzavřených pozic, ne unrealized z otevřených
      const totalRealizedPnl = closedPositions.reduce((sum, pos) => {
        return sum + (toNumber(pos.realizedPnl) || 0);
      }, 0);

      // Total PnL = jen realizované PnL (z uzavřených pozic)
      const totalPnlUsd = totalRealizedPnl;
      const totalPnlPercent = INITIAL_CAPITAL_USD > 0 ? (totalPnlUsd / INITIAL_CAPITAL_USD) * 100 : 0;

      // Total value = initial capital + realized PnL
      // (nebo můžeme počítat: initial capital - total cost + realized PnL + open positions cost)
      // Pro zobrazení používáme: initial capital + realized PnL (bez unrealized PnL)
      const totalValueUsd = INITIAL_CAPITAL_USD + totalRealizedPnl;

      // Calculate win rate
      const winningTrades = closedPositions.filter(pos => (toNumber(pos.realizedPnl) || 0) > 0).length;
      const winRate = closedPositions.length > 0 ? winningTrades / closedPositions.length : null;

      // Calculate stats by model
      const smartCopyOpen = openPositions.filter(pos => pos.meta?.model === 'smart-copy');
      const consensusOpen = openPositions.filter(pos => pos.meta?.model === 'consensus');
      
      // Get all closed trades with meta to filter by model
      const { data: allClosedData } = await supabase
        .from('PaperTrade')
        .select('realizedPnl, realizedPnlPercent, amountBase, meta')
        .eq('status', 'closed')
        .eq('side', 'buy');
      
      const allClosed = allClosedData || [];
      const smartCopyClosed = allClosed.filter((pos: any) => {
        const meta = pos.meta || {};
        return meta.model === 'smart-copy';
      });
      const consensusClosed = allClosed.filter((pos: any) => {
        const meta = pos.meta || {};
        return meta.model === 'consensus';
      });

      // Smart Copy stats
      const smartCopyTotalTrades = smartCopyOpen.length + smartCopyClosed.length;
      const smartCopyOpenCost = smartCopyOpen.reduce((sum, pos) => sum + pos.amountBase, 0);
      const smartCopyClosedCost = smartCopyClosed.reduce((sum, pos) => toNumber(pos.amountBase), 0);
      const smartCopyTotalCost = smartCopyOpenCost + smartCopyClosedCost;
      const smartCopyTotalPnl = smartCopyClosed.reduce((sum, pos) => sum + (toNumber(pos.realizedPnl) || 0), 0);
      const smartCopyTotalPnlPercent = smartCopyTotalCost > 0 ? (smartCopyTotalPnl / smartCopyTotalCost) * 100 : 0;
      const smartCopyWinning = smartCopyClosed.filter(pos => (toNumber(pos.realizedPnl) || 0) > 0).length;
      const smartCopyWinRate = smartCopyClosed.length > 0 ? smartCopyWinning / smartCopyClosed.length : null;

      // Consensus stats
      const consensusTotalTrades = consensusOpen.length + consensusClosed.length;
      const consensusOpenCost = consensusOpen.reduce((sum, pos) => sum + pos.amountBase, 0);
      const consensusClosedCost = consensusClosed.reduce((sum, pos) => toNumber(pos.amountBase), 0);
      const consensusTotalCost = consensusOpenCost + consensusClosedCost;
      const consensusTotalPnl = consensusClosed.reduce((sum, pos) => sum + (toNumber(pos.realizedPnl) || 0), 0);
      const consensusTotalPnlPercent = consensusTotalCost > 0 ? (consensusTotalPnl / consensusTotalCost) * 100 : 0;
      const consensusWinning = consensusClosed.filter(pos => (toNumber(pos.realizedPnl) || 0) > 0).length;
      const consensusWinRate = consensusClosed.length > 0 ? consensusWinning / consensusClosed.length : null;

      return {
        totalValueUsd,
        totalCostUsd,
        totalPnlUsd,
        totalPnlPercent,
        openPositions: openPositions.length,
        closedPositions: closedPositions.length,
        winRate,
        totalTrades,
        initialCapital: INITIAL_CAPITAL_USD,
        byModel: {
          'smart-copy': {
            totalTrades: smartCopyTotalTrades,
            openPositions: smartCopyOpen.length,
            closedPositions: smartCopyClosed.length,
            totalPnlUsd: smartCopyTotalPnl,
            totalPnlPercent: smartCopyTotalPnlPercent,
            winRate: smartCopyWinRate,
            totalCostUsd: smartCopyTotalCost,
          },
          'consensus': {
            totalTrades: consensusTotalTrades,
            openPositions: consensusOpen.length,
            closedPositions: consensusClosed.length,
            totalPnlUsd: consensusTotalPnl,
            totalPnlPercent: consensusTotalPnlPercent,
            winRate: consensusWinRate,
            totalCostUsd: consensusTotalCost,
          },
        },
      };
    } catch (error: any) {
      // If table doesn't exist, return default values
      if (error.message?.includes('does not exist') || error.message?.includes('42P01')) {
        console.warn('⚠️  PaperTrade table does not exist yet. Run ADD_PAPER_TRADING.sql migration.');
        return {
          totalValueUsd: INITIAL_CAPITAL_USD,
          totalCostUsd: 0,
          totalPnlUsd: 0,
          totalPnlPercent: 0,
          openPositions: 0,
          closedPositions: 0,
          winRate: null,
          totalTrades: 0,
          initialCapital: INITIAL_CAPITAL_USD,
        };
      }
      throw error;
    }
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
