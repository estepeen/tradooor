import { prisma, generateId } from '../lib/prisma.js';

export type ExitSignalType =
  | 'wallet_exit'
  | 'stop_loss'
  | 'take_profit'
  | 'trailing_stop'
  | 'ai_recommendation'
  | 'time_based'
  | 'momentum_loss'
  | 'volume_drop';

export type ExitStrength = 'weak' | 'medium' | 'strong';

export type ExitRecommendation =
  | 'hold'
  | 'partial_exit_25'
  | 'partial_exit_50'
  | 'partial_exit_75'
  | 'full_exit';

export interface ExitSignalRecord {
  id: string;
  positionId: string;
  tokenId: string;

  // Signal type
  type: ExitSignalType;
  strength: ExitStrength;
  recommendation: ExitRecommendation;

  // Context at signal time
  priceAtSignal: number | null;
  pnlPercentAtSignal: number | null;
  drawdownAtSignal: number | null;

  // Wallet exit context
  walletsExitedCount: number | null;
  walletsHoldingCount: number | null;
  triggerWalletId: string | null;
  triggerTradeId: string | null;
  triggerReason: string | null;

  // AI context
  aiDecision: string | null;
  aiConfidence: number | null;
  aiReasoning: string | null;

  // Market context
  marketCapAtSignal: number | null;
  liquidityAtSignal: number | null;
  volume1hAtSignal: number | null;

  // Notification
  notificationSent: boolean;
  notificationSentAt: Date | null;
  discordMessageId: string | null;

  // Outcome
  wasActedOn: boolean | null;
  pnlIfActed: number | null;
  pnlActual: number | null;

  createdAt: Date;
}

export class ExitSignalRepository {
  async create(data: {
    positionId: string;
    tokenId: string;
    type: ExitSignalType;
    strength: ExitStrength;
    recommendation: ExitRecommendation;
    priceAtSignal?: number | null;
    pnlPercentAtSignal?: number | null;
    drawdownAtSignal?: number | null;
    walletsExitedCount?: number | null;
    walletsHoldingCount?: number | null;
    triggerWalletId?: string | null;
    triggerTradeId?: string | null;
    triggerReason?: string | null;
    aiDecision?: string | null;
    aiConfidence?: number | null;
    aiReasoning?: string | null;
    marketCapAtSignal?: number | null;
    liquidityAtSignal?: number | null;
    volume1hAtSignal?: number | null;
  }): Promise<ExitSignalRecord> {
    const result = await prisma.exitSignal.create({
      data: {
        id: generateId(),
        positionId: data.positionId,
        tokenId: data.tokenId,
        type: data.type,
        strength: data.strength,
        recommendation: data.recommendation,
        priceAtSignal: data.priceAtSignal ?? undefined,
        pnlPercentAtSignal: data.pnlPercentAtSignal ?? undefined,
        drawdownAtSignal: data.drawdownAtSignal ?? undefined,
        walletsExitedCount: data.walletsExitedCount ?? undefined,
        walletsHoldingCount: data.walletsHoldingCount ?? undefined,
        triggerWalletId: data.triggerWalletId ?? undefined,
        triggerTradeId: data.triggerTradeId ?? undefined,
        triggerReason: data.triggerReason ?? undefined,
        aiDecision: data.aiDecision ?? undefined,
        aiConfidence: data.aiConfidence ?? undefined,
        aiReasoning: data.aiReasoning ?? undefined,
        marketCapAtSignal: data.marketCapAtSignal ?? undefined,
        liquidityAtSignal: data.liquidityAtSignal ?? undefined,
        volume1hAtSignal: data.volume1hAtSignal ?? undefined,
      },
    });

    return this.mapToRecord(result);
  }

  async findById(id: string): Promise<ExitSignalRecord | null> {
    const result = await prisma.exitSignal.findUnique({
      where: { id },
    });
    return result ? this.mapToRecord(result) : null;
  }

  async findByPositionId(
    positionId: string,
    options?: {
      type?: ExitSignalType;
      limit?: number;
    }
  ): Promise<ExitSignalRecord[]> {
    const where: any = { positionId };

    if (options?.type) {
      where.type = options.type;
    }

    const results = await prisma.exitSignal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...(options?.limit && { take: options.limit }),
    });

    return results.map(this.mapToRecord);
  }

  async findRecent(options?: {
    hours?: number;
    type?: ExitSignalType;
    strength?: ExitStrength;
    limit?: number;
  }): Promise<ExitSignalRecord[]> {
    const where: any = {};

    if (options?.hours) {
      where.createdAt = {
        gte: new Date(Date.now() - options.hours * 60 * 60 * 1000),
      };
    }

    if (options?.type) {
      where.type = options.type;
    }

    if (options?.strength) {
      where.strength = options.strength;
    }

    const results = await prisma.exitSignal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...(options?.limit && { take: options.limit }),
    });

    return results.map(this.mapToRecord);
  }

  async findPendingNotifications(limit: number = 50): Promise<ExitSignalRecord[]> {
    const results = await prisma.exitSignal.findMany({
      where: {
        notificationSent: false,
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    return results.map(this.mapToRecord);
  }

  async markNotificationSent(
    id: string,
    discordMessageId?: string
  ): Promise<ExitSignalRecord | null> {
    const result = await prisma.exitSignal.update({
      where: { id },
      data: {
        notificationSent: true,
        notificationSentAt: new Date(),
        ...(discordMessageId && { discordMessageId }),
      },
    });

    return this.mapToRecord(result);
  }

  async updateOutcome(
    id: string,
    wasActedOn: boolean,
    pnlIfActed: number,
    pnlActual: number
  ): Promise<ExitSignalRecord | null> {
    const result = await prisma.exitSignal.update({
      where: { id },
      data: {
        wasActedOn,
        pnlIfActed,
        pnlActual,
      },
    });

    return this.mapToRecord(result);
  }

  async countByType(options?: {
    hours?: number;
    positionId?: string;
  }): Promise<Record<ExitSignalType, number>> {
    const where: any = {};

    if (options?.hours) {
      where.createdAt = {
        gte: new Date(Date.now() - options.hours * 60 * 60 * 1000),
      };
    }

    if (options?.positionId) {
      where.positionId = options.positionId;
    }

    const results = await prisma.exitSignal.groupBy({
      by: ['type'],
      where,
      _count: true,
    });

    const counts: Record<string, number> = {};
    for (const result of results) {
      counts[result.type] = result._count;
    }

    return counts as Record<ExitSignalType, number>;
  }

  async getAnalytics(options?: {
    days?: number;
  }): Promise<{
    totalSignals: number;
    byType: Record<string, number>;
    byStrength: Record<string, number>;
    byRecommendation: Record<string, number>;
    avgPnlAtSignal: number;
    actedOnRate: number;
  }> {
    const where: any = {};

    if (options?.days) {
      where.createdAt = {
        gte: new Date(Date.now() - options.days * 24 * 60 * 60 * 1000),
      };
    }

    const allSignals = await prisma.exitSignal.findMany({ where });

    const byType: Record<string, number> = {};
    const byStrength: Record<string, number> = {};
    const byRecommendation: Record<string, number> = {};

    for (const signal of allSignals) {
      byType[signal.type] = (byType[signal.type] || 0) + 1;
      byStrength[signal.strength] = (byStrength[signal.strength] || 0) + 1;
      byRecommendation[signal.recommendation] = (byRecommendation[signal.recommendation] || 0) + 1;
    }

    const avgPnlAtSignal = allSignals.length > 0
      ? allSignals.reduce((sum, s) => sum + (Number(s.pnlPercentAtSignal) || 0), 0) / allSignals.length
      : 0;

    const withOutcome = allSignals.filter(s => s.wasActedOn !== null);
    const actedOnRate = withOutcome.length > 0
      ? (withOutcome.filter(s => s.wasActedOn).length / withOutcome.length) * 100
      : 0;

    return {
      totalSignals: allSignals.length,
      byType,
      byStrength,
      byRecommendation,
      avgPnlAtSignal,
      actedOnRate,
    };
  }

  private mapToRecord(result: any): ExitSignalRecord {
    return {
      id: result.id,
      positionId: result.positionId,
      tokenId: result.tokenId,
      type: result.type as ExitSignalType,
      strength: result.strength as ExitStrength,
      recommendation: result.recommendation as ExitRecommendation,
      priceAtSignal: result.priceAtSignal ? Number(result.priceAtSignal) : null,
      pnlPercentAtSignal: result.pnlPercentAtSignal ? Number(result.pnlPercentAtSignal) : null,
      drawdownAtSignal: result.drawdownAtSignal ? Number(result.drawdownAtSignal) : null,
      walletsExitedCount: result.walletsExitedCount ?? null,
      walletsHoldingCount: result.walletsHoldingCount ?? null,
      triggerWalletId: result.triggerWalletId ?? null,
      triggerTradeId: result.triggerTradeId ?? null,
      triggerReason: result.triggerReason ?? null,
      aiDecision: result.aiDecision ?? null,
      aiConfidence: result.aiConfidence ?? null,
      aiReasoning: result.aiReasoning ?? null,
      marketCapAtSignal: result.marketCapAtSignal ? Number(result.marketCapAtSignal) : null,
      liquidityAtSignal: result.liquidityAtSignal ? Number(result.liquidityAtSignal) : null,
      volume1hAtSignal: result.volume1hAtSignal ? Number(result.volume1hAtSignal) : null,
      notificationSent: result.notificationSent,
      notificationSentAt: result.notificationSentAt ?? null,
      discordMessageId: result.discordMessageId ?? null,
      wasActedOn: result.wasActedOn ?? null,
      pnlIfActed: result.pnlIfActed ? Number(result.pnlIfActed) : null,
      pnlActual: result.pnlActual ? Number(result.pnlActual) : null,
      createdAt: result.createdAt,
    };
  }
}
