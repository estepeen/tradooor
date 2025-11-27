import { supabase, TABLES, generateId } from '../lib/supabase.js';

export interface TradeOutcomeData {
  tradeId: string;
  walletId: string;
  tokenId: string;
  outcomeType?: 'win' | 'loss' | 'breakeven' | 'unknown';
  outcomeCategory?: 'big_win' | 'small_win' | 'small_loss' | 'big_loss' | 'breakeven';
  realizedPnlUsd?: number;
  realizedPnlPercent?: number;
  tokenPriceChange1hPercent?: number;
  tokenPriceChange24hPercent?: number;
  tokenPriceChange7dPercent?: number;
  tokenOutcome?: 'pump' | 'dump' | 'sideways' | 'unknown';
  positionClosedAt?: Date;
  positionHoldTimeSeconds?: number;
  positionFinalPnlUsd?: number;
  positionFinalPnlPercent?: number;
}

export class TradeOutcomeRepository {
  async findByTradeId(tradeId: string) {
    const { data, error } = await supabase
      .from(TABLES.TRADE_OUTCOME)
      .select('*')
      .eq('tradeId', tradeId)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to fetch trade outcome: ${error.message}`);
    }

    return data || null;
  }

  async findByWalletId(walletId: string, limit?: number) {
    let query = supabase
      .from(TABLES.TRADE_OUTCOME)
      .select('*')
      .eq('walletId', walletId)
      .order('calculatedAt', { ascending: false });

    if (limit) {
      query = query.limit(limit);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to fetch trade outcomes: ${error.message}`);
    }

    return data || [];
  }

  async create(data: TradeOutcomeData) {
    const existing = await this.findByTradeId(data.tradeId);
    if (existing) {
      return existing;
    }

    const payload = {
      id: generateId(),
      tradeId: data.tradeId,
      walletId: data.walletId,
      tokenId: data.tokenId,
      outcomeType: data.outcomeType ?? null,
      outcomeCategory: data.outcomeCategory ?? null,
      realizedPnlUsd: data.realizedPnlUsd?.toString() ?? null,
      realizedPnlPercent: data.realizedPnlPercent?.toString() ?? null,
      tokenPriceChange1hPercent: data.tokenPriceChange1hPercent?.toString() ?? null,
      tokenPriceChange24hPercent: data.tokenPriceChange24hPercent?.toString() ?? null,
      tokenPriceChange7dPercent: data.tokenPriceChange7dPercent?.toString() ?? null,
      tokenOutcome: data.tokenOutcome ?? null,
      positionClosedAt: data.positionClosedAt?.toISOString() ?? null,
      positionHoldTimeSeconds: data.positionHoldTimeSeconds ?? null,
      positionFinalPnlUsd: data.positionFinalPnlUsd?.toString() ?? null,
      positionFinalPnlPercent: data.positionFinalPnlPercent?.toString() ?? null,
    };

    const { data: created, error } = await supabase
      .from(TABLES.TRADE_OUTCOME)
      .insert(payload)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create trade outcome: ${error.message}`);
    }

    return created;
  }

  async update(tradeId: string, data: Partial<TradeOutcomeData>) {
    const updatePayload: any = {};
    
    if (data.outcomeType !== undefined) updatePayload.outcomeType = data.outcomeType;
    if (data.outcomeCategory !== undefined) updatePayload.outcomeCategory = data.outcomeCategory;
    if (data.realizedPnlUsd !== undefined) updatePayload.realizedPnlUsd = data.realizedPnlUsd?.toString() ?? null;
    if (data.realizedPnlPercent !== undefined) updatePayload.realizedPnlPercent = data.realizedPnlPercent?.toString() ?? null;
    if (data.tokenPriceChange1hPercent !== undefined) updatePayload.tokenPriceChange1hPercent = data.tokenPriceChange1hPercent?.toString() ?? null;
    if (data.tokenPriceChange24hPercent !== undefined) updatePayload.tokenPriceChange24hPercent = data.tokenPriceChange24hPercent?.toString() ?? null;
    if (data.tokenPriceChange7dPercent !== undefined) updatePayload.tokenPriceChange7dPercent = data.tokenPriceChange7dPercent?.toString() ?? null;
    if (data.tokenOutcome !== undefined) updatePayload.tokenOutcome = data.tokenOutcome;
    if (data.positionClosedAt !== undefined) updatePayload.positionClosedAt = data.positionClosedAt?.toISOString() ?? null;
    if (data.positionHoldTimeSeconds !== undefined) updatePayload.positionHoldTimeSeconds = data.positionHoldTimeSeconds;
    if (data.positionFinalPnlUsd !== undefined) updatePayload.positionFinalPnlUsd = data.positionFinalPnlUsd?.toString() ?? null;
    if (data.positionFinalPnlPercent !== undefined) updatePayload.positionFinalPnlPercent = data.positionFinalPnlPercent?.toString() ?? null;

    const { data: updated, error } = await supabase
      .from(TABLES.TRADE_OUTCOME)
      .update(updatePayload)
      .eq('tradeId', tradeId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update trade outcome: ${error.message}`);
    }

    return updated;
  }

  async upsert(data: TradeOutcomeData) {
    const existing = await this.findByTradeId(data.tradeId);
    if (existing) {
      return this.update(data.tradeId, data);
    }
    return this.create(data);
  }
}

