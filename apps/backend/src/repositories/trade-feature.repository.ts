import { prisma } from '../lib/prisma.js';
import { Prisma } from '@prisma/client';

type NullableNumber = number | null | undefined;

const toDecimal = (value: NullableNumber): Prisma.Decimal | null => {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }
  return new Prisma.Decimal(value);
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
    await prisma.tradeFeature.upsert({
      where: { tradeId: data.tradeId },
      create: {
        id: data.tradeId,
        tradeId: data.tradeId,
        walletId: data.walletId,
        tokenId: data.tokenId,
        sizeToken: toDecimal(data.sizeToken),
        sizeUsd: toDecimal(data.sizeUsd),
        priceUsd: toDecimal(data.priceUsd),
        slippageBps: data.slippageBps ?? null,
        dex: data.dex ?? null,
        txTimestamp: data.txTimestamp ?? null,
        positionSizeBeforeToken: toDecimal(data.positionSizeBeforeToken),
        positionSizeBeforeUsd: toDecimal(data.positionSizeBeforeUsd),
        positionSizeAfterToken: toDecimal(data.positionSizeAfterToken),
        positionSizeAfterUsd: toDecimal(data.positionSizeAfterUsd),
        positionSizeChangeMultiplier: toDecimal(data.positionSizeChangeMultiplier),
        avgEntryPriceBeforeUsd: toDecimal(data.avgEntryPriceBeforeUsd),
        avgEntryPriceAfterUsd: toDecimal(data.avgEntryPriceAfterUsd),
        tokenAgeSeconds: data.tokenAgeSeconds ?? null,
        liquidityUsd: toDecimal(data.liquidityUsd),
        volume1hUsd: toDecimal(data.volume1hUsd),
        volume24hUsd: toDecimal(data.volume24hUsd),
        fdvUsd: toDecimal(data.fdvUsd),
        trend5mPercent: toDecimal(data.trend5mPercent),
        trend30mPercent: toDecimal(data.trend30mPercent),
        solPriceUsd: toDecimal(data.solPriceUsd),
        hourOfDay: data.hourOfDay ?? null,
        dayOfWeek: data.dayOfWeek ?? null,
        baseTokenSymbol: data.baseTokenSymbol ?? null,
        meta: data.meta as any,
      },
      update: {
        sizeToken: toDecimal(data.sizeToken),
        sizeUsd: toDecimal(data.sizeUsd),
        priceUsd: toDecimal(data.priceUsd),
        slippageBps: data.slippageBps ?? null,
        dex: data.dex ?? null,
        txTimestamp: data.txTimestamp ?? null,
        positionSizeBeforeToken: toDecimal(data.positionSizeBeforeToken),
        positionSizeBeforeUsd: toDecimal(data.positionSizeBeforeUsd),
        positionSizeAfterToken: toDecimal(data.positionSizeAfterToken),
        positionSizeAfterUsd: toDecimal(data.positionSizeAfterUsd),
        positionSizeChangeMultiplier: toDecimal(data.positionSizeChangeMultiplier),
        avgEntryPriceBeforeUsd: toDecimal(data.avgEntryPriceBeforeUsd),
        avgEntryPriceAfterUsd: toDecimal(data.avgEntryPriceAfterUsd),
        tokenAgeSeconds: data.tokenAgeSeconds ?? null,
        liquidityUsd: toDecimal(data.liquidityUsd),
        volume1hUsd: toDecimal(data.volume1hUsd),
        volume24hUsd: toDecimal(data.volume24hUsd),
        fdvUsd: toDecimal(data.fdvUsd),
        trend5mPercent: toDecimal(data.trend5mPercent),
        trend30mPercent: toDecimal(data.trend30mPercent),
        solPriceUsd: toDecimal(data.solPriceUsd),
        hourOfDay: data.hourOfDay ?? null,
        dayOfWeek: data.dayOfWeek ?? null,
        baseTokenSymbol: data.baseTokenSymbol ?? null,
        meta: data.meta as any,
        updatedAt: new Date(),
      },
    });
  }

  async updateRealizedMetrics(data: TradeFeatureRealizedInput) {
    const updateData: any = {};

    if (data.realizedPnlUsd !== undefined) {
      updateData.realizedPnlUsd = toDecimal(data.realizedPnlUsd);
    }
    if (data.realizedPnlPercent !== undefined) {
      updateData.realizedPnlPercent = toDecimal(data.realizedPnlPercent);
    }
    if (data.holdTimeSeconds !== undefined) {
      updateData.holdTimeSeconds = data.holdTimeSeconds ?? null;
    }

    if (Object.keys(updateData).length === 0) {
      return; // Nothing to update
    }

    updateData.updatedAt = new Date();

    await prisma.tradeFeature.update({
      where: { tradeId: data.tradeId },
      data: updateData,
    });
  }

  async findByTradeId(tradeId: string): Promise<TradeFeatureRecord | null> {
    const feature = await prisma.tradeFeature.findUnique({
      where: { tradeId },
      include: {
        trade: {
          select: {
            side: true,
          },
        },
      },
    });

    if (!feature) {
      return null;
    }

    return this.mapRow(feature);
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
    const updateData: any = {};

    if (data.priceMomentum1mPercent !== undefined) {
      updateData.priceMomentum1mPercent = toDecimal(data.priceMomentum1mPercent);
    }
    if (data.priceMomentum5mPercent !== undefined) {
      updateData.priceMomentum5mPercent = toDecimal(data.priceMomentum5mPercent);
    }
    if (data.priceMomentum15mPercent !== undefined) {
      updateData.priceMomentum15mPercent = toDecimal(data.priceMomentum15mPercent);
    }
    if (data.priceMomentum1hPercent !== undefined) {
      updateData.priceMomentum1hPercent = toDecimal(data.priceMomentum1hPercent);
    }
    if (data.volumeSpike1hMultiplier !== undefined) {
      updateData.volumeSpike1hMultiplier = toDecimal(data.volumeSpike1hMultiplier);
    }
    if (data.volumeSpike24hMultiplier !== undefined) {
      updateData.volumeSpike24hMultiplier = toDecimal(data.volumeSpike24hMultiplier);
    }
    if (data.marketRegime !== undefined) {
      updateData.marketRegime = data.marketRegime;
    }
    if (data.otherSmartWalletsTradingCount !== undefined) {
      updateData.otherSmartWalletsTradingCount = data.otherSmartWalletsTradingCount;
    }
    if (data.otherSmartWalletsTradingSameTokenCount !== undefined) {
      updateData.otherSmartWalletsTradingSameTokenCount = data.otherSmartWalletsTradingSameTokenCount;
    }
    if (data.otherSmartWalletsTradingSameTokenWithin1h !== undefined) {
      updateData.otherSmartWalletsTradingSameTokenWithin1h = data.otherSmartWalletsTradingSameTokenWithin1h;
    }
    if (data.otherSmartWalletsTradingSameTokenWithin24h !== undefined) {
      updateData.otherSmartWalletsTradingSameTokenWithin24h = data.otherSmartWalletsTradingSameTokenWithin24h;
    }
    if (data.avgTimeSinceOtherTradersTradeSeconds !== undefined) {
      updateData.avgTimeSinceOtherTradersTradeSeconds = data.avgTimeSinceOtherTradersTradeSeconds;
    }
    if (data.copyTraderScore !== undefined) {
      updateData.copyTraderScore = data.copyTraderScore ? toDecimal(Number(data.copyTraderScore)) : null;
    }

    if (Object.keys(updateData).length === 0) {
      return; // Nothing to update
    }

    updateData.updatedAt = new Date();

    await prisma.tradeFeature.update({
      where: { tradeId },
      data: updateData,
    });
  }

  async findForWallet(
    walletId: string,
    options?: {
      fromDate?: Date;
      toDate?: Date;
    }
  ): Promise<TradeFeatureRecord[]> {
    const where: any = { walletId };

    if (options?.fromDate || options?.toDate) {
      where.txTimestamp = {};
      if (options.fromDate) {
        where.txTimestamp.gte = options.fromDate;
      }
      if (options.toDate) {
        where.txTimestamp.lte = options.toDate;
      }
    }

    const features = await prisma.tradeFeature.findMany({
      where,
      include: {
        trade: {
          select: {
            side: true,
          },
        },
      },
      orderBy: { txTimestamp: 'desc' },
    });

    return features.map(row => this.mapRow(row));
  }

  private mapRow(row: any): TradeFeatureRecord {
    return {
      id: row.id,
      tradeId: row.tradeId,
      walletId: row.walletId,
      tokenId: row.tokenId,
      sizeToken: row.sizeToken ? Number(row.sizeToken) : null,
      sizeUsd: row.sizeUsd ? Number(row.sizeUsd) : null,
      priceUsd: row.priceUsd ? Number(row.priceUsd) : null,
      slippageBps: row.slippageBps ?? null,
      dex: row.dex ?? null,
      txTimestamp: row.txTimestamp ? new Date(row.txTimestamp) : null,
      positionSizeBeforeToken: row.positionSizeBeforeToken ? Number(row.positionSizeBeforeToken) : null,
      positionSizeBeforeUsd: row.positionSizeBeforeUsd ? Number(row.positionSizeBeforeUsd) : null,
      positionSizeAfterToken: row.positionSizeAfterToken ? Number(row.positionSizeAfterToken) : null,
      positionSizeAfterUsd: row.positionSizeAfterUsd ? Number(row.positionSizeAfterUsd) : null,
      positionSizeChangeMultiplier: row.positionSizeChangeMultiplier ? Number(row.positionSizeChangeMultiplier) : null,
      avgEntryPriceBeforeUsd: row.avgEntryPriceBeforeUsd ? Number(row.avgEntryPriceBeforeUsd) : null,
      avgEntryPriceAfterUsd: row.avgEntryPriceAfterUsd ? Number(row.avgEntryPriceAfterUsd) : null,
      realizedPnlUsd: row.realizedPnlUsd ? Number(row.realizedPnlUsd) : null,
      realizedPnlPercent: row.realizedPnlPercent ? Number(row.realizedPnlPercent) : null,
      holdTimeSeconds: row.holdTimeSeconds ?? null,
      tokenAgeSeconds: row.tokenAgeSeconds ?? null,
      liquidityUsd: row.liquidityUsd ? Number(row.liquidityUsd) : null,
      volume1hUsd: row.volume1hUsd ? Number(row.volume1hUsd) : null,
      volume24hUsd: row.volume24hUsd ? Number(row.volume24hUsd) : null,
      fdvUsd: row.fdvUsd ? Number(row.fdvUsd) : null,
      trend5mPercent: row.trend5mPercent ? Number(row.trend5mPercent) : null,
      trend30mPercent: row.trend30mPercent ? Number(row.trend30mPercent) : null,
      solPriceUsd: row.solPriceUsd ? Number(row.solPriceUsd) : null,
      hourOfDay: row.hourOfDay ?? null,
      dayOfWeek: row.dayOfWeek ?? null,
      baseTokenSymbol: row.baseTokenSymbol ?? null,
      meta: row.meta as any,
      side: row.trade?.side ?? null,
    };
  }
}

