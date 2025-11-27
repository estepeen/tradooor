import { supabase, TABLES } from '../lib/supabase.js';

type NullableNumber = number | null | undefined;

const toNumeric = (value: NullableNumber) => {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }
  return value.toString();
};

const toNumber = (value: any) => (value === null || value === undefined ? null : Number(value));

export interface TradeFeatureRecord {
  id: string;
  tradeId: string;
  walletId: string;
  tokenId: string;
  sizeToken: number | null;
  sizeUsd: number | null;
  priceUsd: number | null;
  slippageBps: number | null;
  dex: string | null;
  txTimestamp: Date | null;
  positionSizeBeforeToken: number | null;
  positionSizeBeforeUsd: number | null;
  positionSizeAfterToken: number | null;
  positionSizeAfterUsd: number | null;
  positionSizeChangeMultiplier: number | null;
  avgEntryPriceBeforeUsd: number | null;
  avgEntryPriceAfterUsd: number | null;
  realizedPnlUsd: number | null;
  realizedPnlPercent: number | null;
  holdTimeSeconds: number | null;
  tokenAgeSeconds: number | null;
  liquidityUsd: number | null;
  volume1hUsd: number | null;
  volume24hUsd: number | null;
  fdvUsd: number | null;
  trend5mPercent: number | null;
  trend30mPercent: number | null;
  solPriceUsd: number | null;
  hourOfDay: number | null;
  dayOfWeek: number | null;
  baseTokenSymbol: string | null;
  meta: Record<string, any> | null;
  side: string | null;
}

export type TradeFeatureBaseInput = {
  tradeId: string;
  walletId: string;
  tokenId: string;
  sizeToken?: number | null;
  sizeUsd?: number | null;
  priceUsd?: number | null;
  slippageBps?: number | null;
  dex?: string | null;
  txTimestamp?: Date | null;
  positionSizeBeforeToken?: number | null;
  positionSizeBeforeUsd?: number | null;
  positionSizeAfterToken?: number | null;
  positionSizeAfterUsd?: number | null;
  positionSizeChangeMultiplier?: number | null;
  avgEntryPriceBeforeUsd?: number | null;
  avgEntryPriceAfterUsd?: number | null;
  tokenAgeSeconds?: number | null;
  liquidityUsd?: number | null;
  volume1hUsd?: number | null;
  volume24hUsd?: number | null;
  fdvUsd?: number | null;
  trend5mPercent?: number | null;
  trend30mPercent?: number | null;
  solPriceUsd?: number | null;
  hourOfDay?: number | null;
  dayOfWeek?: number | null;
  baseTokenSymbol?: string | null;
  meta?: Record<string, any> | null;
};

export type TradeFeatureRealizedInput = {
  tradeId: string;
  realizedPnlUsd?: number | null;
  realizedPnlPercent?: number | null;
  holdTimeSeconds?: number | null;
};

export class TradeFeatureRepository {
  async upsertBaseFeature(data: TradeFeatureBaseInput) {
    const payload: Record<string, any> = {
      id: data.tradeId,
      tradeId: data.tradeId,
      walletId: data.walletId,
      tokenId: data.tokenId,
      sizeToken: toNumeric(data.sizeToken),
      sizeUsd: toNumeric(data.sizeUsd),
      priceUsd: toNumeric(data.priceUsd),
      slippageBps: data.slippageBps ?? null,
      dex: data.dex ?? null,
      txTimestamp: data.txTimestamp ? data.txTimestamp.toISOString() : null,
      positionSizeBeforeToken: toNumeric(data.positionSizeBeforeToken),
      positionSizeBeforeUsd: toNumeric(data.positionSizeBeforeUsd),
      positionSizeAfterToken: toNumeric(data.positionSizeAfterToken),
      positionSizeAfterUsd: toNumeric(data.positionSizeAfterUsd),
      positionSizeChangeMultiplier: toNumeric(data.positionSizeChangeMultiplier),
      avgEntryPriceBeforeUsd: toNumeric(data.avgEntryPriceBeforeUsd),
      avgEntryPriceAfterUsd: toNumeric(data.avgEntryPriceAfterUsd),
      tokenAgeSeconds: data.tokenAgeSeconds ?? null,
      liquidityUsd: toNumeric(data.liquidityUsd),
      volume1hUsd: toNumeric(data.volume1hUsd),
      volume24hUsd: toNumeric(data.volume24hUsd),
      fdvUsd: toNumeric(data.fdvUsd),
      trend5mPercent: toNumeric(data.trend5mPercent),
      trend30mPercent: toNumeric(data.trend30mPercent),
      solPriceUsd: toNumeric(data.solPriceUsd),
      hourOfDay: data.hourOfDay ?? null,
      dayOfWeek: data.dayOfWeek ?? null,
      baseTokenSymbol: data.baseTokenSymbol ?? null,
      meta: data.meta ?? null,
      updatedAt: new Date().toISOString(),
    };

    const { error } = await supabase
      .from(TABLES.TRADE_FEATURE)
      .upsert(payload, { onConflict: 'tradeId' });

    if (error) {
      throw new Error(`Failed to upsert trade feature: ${error.message}`);
    }
  }

  async updateRealizedMetrics(data: TradeFeatureRealizedInput) {
    const payload: Record<string, any> = {
      updatedAt: new Date().toISOString(),
    };

    if (data.realizedPnlUsd !== undefined) {
      payload.realizedPnlUsd = toNumeric(data.realizedPnlUsd);
    }
    if (data.realizedPnlPercent !== undefined) {
      payload.realizedPnlPercent = toNumeric(data.realizedPnlPercent);
    }
    if (data.holdTimeSeconds !== undefined) {
      payload.holdTimeSeconds = data.holdTimeSeconds ?? null;
    }

    if (Object.keys(payload).length === 1) {
      return; // Only updatedAt present -> nothing to update
    }

    const { error } = await supabase
      .from(TABLES.TRADE_FEATURE)
      .update(payload)
      .eq('tradeId', data.tradeId);

    if (error) {
      throw new Error(`Failed to update trade feature metrics: ${error.message}`);
    }
  }

  async findByTradeId(tradeId: string): Promise<TradeFeatureRecord | null> {
    const { data, error } = await supabase
      .from(TABLES.TRADE_FEATURE)
      .select(
        `
          *,
          trade:${TABLES.TRADE}(side)
        `
      )
      .eq('tradeId', tradeId)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to fetch trade feature: ${error.message}`);
    }

    if (!data) {
      return null;
    }

    return this.mapRow(data);
  }

  async update(tradeId: string, data: {
    priceMomentum1mPercent?: number | null;
    priceMomentum5mPercent?: number | null;
    priceMomentum15mPercent?: number | null;
    priceMomentum1hPercent?: number | null;
    volumeSpike1hMultiplier?: number | null;
    volumeSpike24hMultiplier?: number | null;
    marketRegime?: 'bull' | 'bear' | 'sideways' | null;
    otherSmartWalletsTradingCount?: number | null;
    otherSmartWalletsTradingSameTokenCount?: number | null;
    otherSmartWalletsTradingSameTokenWithin1h?: number | null;
    otherSmartWalletsTradingSameTokenWithin24h?: number | null;
    avgTimeSinceOtherTradersTradeSeconds?: number | null;
    copyTraderScore?: string | null;
  }) {
    const payload: Record<string, any> = {
      updatedAt: new Date().toISOString(),
    };

    if (data.priceMomentum1mPercent !== undefined) {
      payload.priceMomentum1mPercent = toNumeric(data.priceMomentum1mPercent);
    }
    if (data.priceMomentum5mPercent !== undefined) {
      payload.priceMomentum5mPercent = toNumeric(data.priceMomentum5mPercent);
    }
    if (data.priceMomentum15mPercent !== undefined) {
      payload.priceMomentum15mPercent = toNumeric(data.priceMomentum15mPercent);
    }
    if (data.priceMomentum1hPercent !== undefined) {
      payload.priceMomentum1hPercent = toNumeric(data.priceMomentum1hPercent);
    }
    if (data.volumeSpike1hMultiplier !== undefined) {
      payload.volumeSpike1hMultiplier = toNumeric(data.volumeSpike1hMultiplier);
    }
    if (data.volumeSpike24hMultiplier !== undefined) {
      payload.volumeSpike24hMultiplier = toNumeric(data.volumeSpike24hMultiplier);
    }
    if (data.marketRegime !== undefined) {
      payload.marketRegime = data.marketRegime;
    }
    if (data.otherSmartWalletsTradingCount !== undefined) {
      payload.otherSmartWalletsTradingCount = data.otherSmartWalletsTradingCount;
    }
    if (data.otherSmartWalletsTradingSameTokenCount !== undefined) {
      payload.otherSmartWalletsTradingSameTokenCount = data.otherSmartWalletsTradingSameTokenCount;
    }
    if (data.otherSmartWalletsTradingSameTokenWithin1h !== undefined) {
      payload.otherSmartWalletsTradingSameTokenWithin1h = data.otherSmartWalletsTradingSameTokenWithin1h;
    }
    if (data.otherSmartWalletsTradingSameTokenWithin24h !== undefined) {
      payload.otherSmartWalletsTradingSameTokenWithin24h = data.otherSmartWalletsTradingSameTokenWithin24h;
    }
    if (data.avgTimeSinceOtherTradersTradeSeconds !== undefined) {
      payload.avgTimeSinceOtherTradersTradeSeconds = data.avgTimeSinceOtherTradersTradeSeconds;
    }
    if (data.copyTraderScore !== undefined) {
      payload.copyTraderScore = data.copyTraderScore ? toNumeric(Number(data.copyTraderScore)) : null;
    }

    if (Object.keys(payload).length === 1) {
      return; // Only updatedAt present -> nothing to update
    }

    const { error } = await supabase
      .from(TABLES.TRADE_FEATURE)
      .update(payload)
      .eq('tradeId', tradeId);

    if (error) {
      throw new Error(`Failed to update trade feature: ${error.message}`);
    }
  }

  async findForWallet(
    walletId: string,
    options?: {
      fromDate?: Date;
      toDate?: Date;
    }
  ): Promise<TradeFeatureRecord[]> {
    let query = supabase
      .from(TABLES.TRADE_FEATURE)
      .select(
        `
          *,
          trade:${TABLES.TRADE}(side)
        `
      )
      .eq('walletId', walletId)
      .order('txTimestamp', { ascending: false });

    if (options?.fromDate) {
      query = query.gte('txTimestamp', options.fromDate.toISOString());
    }

    if (options?.toDate) {
      query = query.lte('txTimestamp', options.toDate.toISOString());
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to fetch trade features: ${error.message}`);
    }

    return (data ?? []).map(row => this.mapRow(row));
  }

  private mapRow(row: any): TradeFeatureRecord {
    return {
      id: row.id,
      tradeId: row.tradeId,
      walletId: row.walletId,
      tokenId: row.tokenId,
      sizeToken: toNumber(row.sizeToken),
      sizeUsd: toNumber(row.sizeUsd),
      priceUsd: toNumber(row.priceUsd),
      slippageBps: row.slippageBps ?? null,
      dex: row.dex ?? null,
      txTimestamp: row.txTimestamp ? new Date(row.txTimestamp) : null,
      positionSizeBeforeToken: toNumber(row.positionSizeBeforeToken),
      positionSizeBeforeUsd: toNumber(row.positionSizeBeforeUsd),
      positionSizeAfterToken: toNumber(row.positionSizeAfterToken),
      positionSizeAfterUsd: toNumber(row.positionSizeAfterUsd),
      positionSizeChangeMultiplier: toNumber(row.positionSizeChangeMultiplier),
      avgEntryPriceBeforeUsd: toNumber(row.avgEntryPriceBeforeUsd),
      avgEntryPriceAfterUsd: toNumber(row.avgEntryPriceAfterUsd),
      realizedPnlUsd: toNumber(row.realizedPnlUsd),
      realizedPnlPercent: toNumber(row.realizedPnlPercent),
      holdTimeSeconds: row.holdTimeSeconds ?? null,
      tokenAgeSeconds: row.tokenAgeSeconds ?? null,
      liquidityUsd: toNumber(row.liquidityUsd),
      volume1hUsd: toNumber(row.volume1hUsd),
      volume24hUsd: toNumber(row.volume24hUsd),
      fdvUsd: toNumber(row.fdvUsd),
      trend5mPercent: toNumber(row.trend5mPercent),
      trend30mPercent: toNumber(row.trend30mPercent),
      solPriceUsd: toNumber(row.solPriceUsd),
      hourOfDay: row.hourOfDay ?? null,
      dayOfWeek: row.dayOfWeek ?? null,
      baseTokenSymbol: row.baseTokenSymbol ?? null,
      meta: row.meta ?? null,
      side: row.trade?.side ?? null,
    };
  }
}

