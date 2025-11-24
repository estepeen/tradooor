import { supabase, TABLES } from '../lib/supabase.js';

type NullableNumber = number | null | undefined;

const toNumeric = (value: NullableNumber) => {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }
  return value.toString();
};

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
}

