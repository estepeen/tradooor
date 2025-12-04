import { supabase, TABLES, generateId } from '../lib/supabase.js';

export class TradeRepository {
  async findByWalletId(
    walletId: string,
    params?: {
      page?: number;
      pageSize?: number;
      tokenId?: string;
      fromDate?: Date;
      toDate?: Date;
    }
  ) {
    const page = params?.page ?? 1;
    const pageSize = params?.pageSize ?? 50;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let query = supabase
      .from(TABLES.TRADE)
      .select(`
        *,
        token:${TABLES.TOKEN}(*),
        wallet:${TABLES.SMART_WALLET}(id, address, label)
      `, { count: 'exact' })
      .eq('walletId', walletId);

    if (params?.tokenId) {
      query = query.eq('tokenId', params.tokenId);
    }

    if (params?.fromDate) {
      query = query.gte('timestamp', params.fromDate.toISOString());
    }

    if (params?.toDate) {
      query = query.lte('timestamp', params.toDate.toISOString());
    }

    query = query
      .order('timestamp', { ascending: false })
      .range(from, to);

    const { data: trades, error, count } = await query;

    if (error) {
      throw new Error(`Failed to fetch trades: ${error.message}`);
    }

    return {
      trades: trades ?? [],
      total: count ?? 0,
      page,
      pageSize,
    };
  }

  async create(data: {
    txSignature: string;
    walletId: string;
    tokenId: string;
    side: 'buy' | 'sell' | 'void';
    amountToken: number;
    amountBase: number;
    priceBasePerToken: number;
    timestamp: Date;
    dex: string;
    positionId?: string;
    valueUsd?: number;
    pnlUsd?: number;
    pnlPercent?: number;
    meta?: Record<string, any>;
  }) {
    // Prevent duplicates by txSignature (primary guard); DB has UNIQUE constraint too
    // Quick client-side check
    const existing = await this.findBySignature(data.txSignature);
    if (existing) {
      return existing;
    }

    const payload = {
      id: generateId(),
      txSignature: data.txSignature,
      walletId: data.walletId,
      tokenId: data.tokenId,
      side: data.side,
      amountToken: data.amountToken.toString(),
      amountBase: data.amountBase.toString(),
      priceBasePerToken: data.priceBasePerToken.toString(),
      timestamp: data.timestamp.toISOString(),
      dex: data.dex,
      positionId: data.positionId ?? null,
      valueUsd: data.valueUsd?.toString() ?? null,
      pnlUsd: data.pnlUsd?.toString() ?? null,
      pnlPercent: data.pnlPercent?.toString() ?? null,
      meta: data.meta ?? null,
    };

    // Insert with duplicate protection: if unique constraint hits, return existing row
    const { data: result, error } = await supabase
      .from(TABLES.TRADE)
      .insert(payload)
      .select()
      .single();

    if (error) {
      // Handle unique-violation gracefully (Postgres code 23505)
      if ((error as any).code === '23505' || /duplicate key value/i.test(error.message)) {
        const already = await this.findBySignature(data.txSignature);
        if (already) return already;
      }
      throw new Error(`Failed to create trade: ${error.message}`);
    }

    return result;
  }

  async findAllForMetrics(walletId: string, excludeVoid: boolean = true) {
    let query = supabase
      .from(TABLES.TRADE)
      .select(`
        *,
        token:${TABLES.TOKEN}(*)
      `)
      .eq('walletId', walletId);
    
    // Vyloučit void trades z PnL výpočtů
    // Použij .in() místo .neq() pro lepší kompatibilitu s Supabase
    if (excludeVoid) {
      query = query.in('side', ['buy', 'sell']);
    }
    
    const { data: trades, error } = await query.order('timestamp', { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch trades for metrics: ${error.message}`);
    }

    // Convert Decimal strings back to numbers for metrics calculation
    return (trades ?? []).map(trade => ({
      ...trade,
      amountToken: Number(trade.amountToken),
      amountBase: Number(trade.amountBase),
      priceBasePerToken: Number(trade.priceBasePerToken),
      timestamp: new Date(trade.timestamp),
    }));
  }

  async findBySignature(txSignature: string) {
    const { data, error } = await supabase
      .from(TABLES.TRADE)
      .select('*')
      .eq('txSignature', txSignature)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // No rows returned
        return null;
      }
      throw new Error(`Failed to find trade by signature: ${error.message}`);
    }

    return data;
  }

  /**
   * Získá všechny trady (pro re-processing)
   */
  async findAll(limit?: number, offset?: number) {
    let query = supabase
      .from(TABLES.TRADE)
      .select(`
        *,
        wallet:${TABLES.SMART_WALLET}(id, address),
        token:${TABLES.TOKEN}(id, mintAddress)
      `, { count: 'exact' })
      .order('timestamp', { ascending: true });

    if (limit !== undefined) {
      query = query.limit(limit);
    }
    if (offset !== undefined) {
      query = query.range(offset, offset + (limit || 1000) - 1);
    }

    const { data: trades, error, count } = await query;

    if (error) {
      throw new Error(`Failed to fetch all trades: ${error.message}`);
    }

    return {
      trades: trades ?? [],
      total: count ?? 0,
    };
  }

  /**
   * Aktualizuje existující trade
   */
  async update(tradeId: string, data: {
    side?: 'buy' | 'sell';
    amountBase?: number;
    priceBasePerToken?: number;
    valueUsd?: number;
    pnlUsd?: number;
    pnlPercent?: number;
  }) {
    const updateData: any = {};
    
    if (data.side !== undefined) {
      updateData.side = data.side;
    }
    if (data.amountBase !== undefined) {
      updateData.amountBase = data.amountBase.toString();
    }
    if (data.priceBasePerToken !== undefined) {
      updateData.priceBasePerToken = data.priceBasePerToken.toString();
    }
    if (data.valueUsd !== undefined) {
      updateData.valueUsd = data.valueUsd !== null ? data.valueUsd.toString() : null;
    }
    if (data.pnlUsd !== undefined) {
      updateData.pnlUsd = data.pnlUsd !== null ? data.pnlUsd.toString() : null;
    }
    if (data.pnlPercent !== undefined) {
      updateData.pnlPercent = data.pnlPercent !== null ? data.pnlPercent.toString() : null;
    }

    const { data: result, error } = await supabase
      .from(TABLES.TRADE)
      .update(updateData)
      .eq('id', tradeId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update trade: ${error.message}`);
    }

    return result;
  }

  async deleteById(tradeId: string): Promise<void> {
    const { error } = await supabase
      .from(TABLES.TRADE)
      .delete()
      .eq('id', tradeId);

    if (error) {
      throw new Error(`Failed to delete trade: ${error.message}`);
    }
  }

  async deleteByWalletAndToken(walletId: string, tokenId: string): Promise<number> {
    const { data, error } = await supabase
      .from(TABLES.TRADE)
      .delete()
      .eq('walletId', walletId)
      .eq('tokenId', tokenId)
      .select('id');

    if (error) {
      throw new Error(`Failed to delete trades: ${error.message}`);
    }

    return data?.length || 0;
  }

  async deleteByIds(tradeIds: string[]): Promise<number> {
    if (tradeIds.length === 0) {
      return 0;
    }

    const { data, error } = await supabase
      .from(TABLES.TRADE)
      .delete()
      .in('id', tradeIds)
      .select('id');

    if (error) {
      throw new Error(`Failed to delete trades: ${error.message}`);
    }

    return data?.length || 0;
  }
}
