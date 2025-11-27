import { supabase, TABLES, generateId } from '../lib/supabase.js';

export interface TradeSequenceData {
  tradeId: string;
  walletId: string;
  tokenId: string;
  sequenceIndex?: number;
  sequenceLength?: number;
  timeSinceLastTradeSeconds?: number;
  timeSinceLastTokenTradeSeconds?: number;
  isTokenSwitch?: boolean;
  previousTokenId?: string;
  tokensInSequence?: number;
  positionSizeChangePercent?: number;
  avgPositionSizeUsd?: number;
  tradesInLastHour?: number;
  tradesInLastDay?: number;
}

export class TradeSequenceRepository {
  async findByTradeId(tradeId: string) {
    const { data, error } = await supabase
      .from(TABLES.TRADE_SEQUENCE)
      .select('*')
      .eq('tradeId', tradeId)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to fetch trade sequence: ${error.message}`);
    }

    return data || null;
  }

  async findByWalletId(walletId: string, limit?: number) {
    let query = supabase
      .from(TABLES.TRADE_SEQUENCE)
      .select('*')
      .eq('walletId', walletId)
      .order('createdAt', { ascending: false });

    if (limit) {
      query = query.limit(limit);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to fetch trade sequences: ${error.message}`);
    }

    return data || [];
  }

  async create(data: TradeSequenceData) {
    const existing = await this.findByTradeId(data.tradeId);
    if (existing) {
      return existing;
    }

    const payload = {
      id: generateId(),
      tradeId: data.tradeId,
      walletId: data.walletId,
      tokenId: data.tokenId,
      sequenceIndex: data.sequenceIndex ?? null,
      sequenceLength: data.sequenceLength ?? null,
      timeSinceLastTradeSeconds: data.timeSinceLastTradeSeconds ?? null,
      timeSinceLastTokenTradeSeconds: data.timeSinceLastTokenTradeSeconds ?? null,
      isTokenSwitch: data.isTokenSwitch ?? false,
      previousTokenId: data.previousTokenId ?? null,
      tokensInSequence: data.tokensInSequence ?? null,
      positionSizeChangePercent: data.positionSizeChangePercent?.toString() ?? null,
      avgPositionSizeUsd: data.avgPositionSizeUsd?.toString() ?? null,
      tradesInLastHour: data.tradesInLastHour ?? null,
      tradesInLastDay: data.tradesInLastDay ?? null,
    };

    const { data: created, error } = await supabase
      .from(TABLES.TRADE_SEQUENCE)
      .insert(payload)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create trade sequence: ${error.message}`);
    }

    return created;
  }

  async update(tradeId: string, data: Partial<TradeSequenceData>) {
    const updatePayload: any = {};
    
    if (data.sequenceIndex !== undefined) updatePayload.sequenceIndex = data.sequenceIndex;
    if (data.sequenceLength !== undefined) updatePayload.sequenceLength = data.sequenceLength;
    if (data.timeSinceLastTradeSeconds !== undefined) updatePayload.timeSinceLastTradeSeconds = data.timeSinceLastTradeSeconds;
    if (data.timeSinceLastTokenTradeSeconds !== undefined) updatePayload.timeSinceLastTokenTradeSeconds = data.timeSinceLastTokenTradeSeconds;
    if (data.isTokenSwitch !== undefined) updatePayload.isTokenSwitch = data.isTokenSwitch;
    if (data.previousTokenId !== undefined) updatePayload.previousTokenId = data.previousTokenId;
    if (data.tokensInSequence !== undefined) updatePayload.tokensInSequence = data.tokensInSequence;
    if (data.positionSizeChangePercent !== undefined) updatePayload.positionSizeChangePercent = data.positionSizeChangePercent?.toString() ?? null;
    if (data.avgPositionSizeUsd !== undefined) updatePayload.avgPositionSizeUsd = data.avgPositionSizeUsd?.toString() ?? null;
    if (data.tradesInLastHour !== undefined) updatePayload.tradesInLastHour = data.tradesInLastHour;
    if (data.tradesInLastDay !== undefined) updatePayload.tradesInLastDay = data.tradesInLastDay;

    const { data: updated, error } = await supabase
      .from(TABLES.TRADE_SEQUENCE)
      .update(updatePayload)
      .eq('tradeId', tradeId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update trade sequence: ${error.message}`);
    }

    return updated;
  }

  async upsert(data: TradeSequenceData) {
    const existing = await this.findByTradeId(data.tradeId);
    if (existing) {
      return this.update(data.tradeId, data);
    }
    return this.create(data);
  }
}

