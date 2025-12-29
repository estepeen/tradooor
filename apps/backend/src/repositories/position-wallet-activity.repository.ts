import { prisma, generateId } from '../lib/prisma.js';

export type WalletActivityStatus = 'holding' | 'partial_exit' | 'full_exit';

export interface PositionWalletActivityRecord {
  id: string;
  positionId: string;
  walletId: string;

  // Entry data
  entryTradeId: string | null;
  entryPriceUsd: number | null;
  entryAmountUsd: number | null;
  entryTimestamp: Date | null;

  // Exit data
  exitTradeId: string | null;
  exitPriceUsd: number | null;
  exitAmountUsd: number | null;
  exitTimestamp: Date | null;

  // Status
  status: WalletActivityStatus;
  holdingPercent: number;

  // PnL
  realizedPnlPercent: number | null;
  realizedPnlUsd: number | null;

  createdAt: Date;
  updatedAt: Date;
}

export class PositionWalletActivityRepository {
  async create(data: {
    positionId: string;
    walletId: string;
    entryTradeId?: string | null;
    entryPriceUsd?: number | null;
    entryAmountUsd?: number | null;
    entryTimestamp?: Date | null;
  }): Promise<PositionWalletActivityRecord> {
    const result = await prisma.positionWalletActivity.create({
      data: {
        id: generateId(),
        positionId: data.positionId,
        walletId: data.walletId,
        entryTradeId: data.entryTradeId ?? undefined,
        entryPriceUsd: data.entryPriceUsd ?? undefined,
        entryAmountUsd: data.entryAmountUsd ?? undefined,
        entryTimestamp: data.entryTimestamp ?? undefined,
        status: 'holding',
        holdingPercent: 100,
      },
    });

    return this.mapToRecord(result);
  }

  async findById(id: string): Promise<PositionWalletActivityRecord | null> {
    const result = await prisma.positionWalletActivity.findUnique({
      where: { id },
    });
    return result ? this.mapToRecord(result) : null;
  }

  async findByPositionAndWallet(
    positionId: string,
    walletId: string
  ): Promise<PositionWalletActivityRecord | null> {
    const result = await prisma.positionWalletActivity.findUnique({
      where: {
        positionId_walletId: { positionId, walletId },
      },
    });
    return result ? this.mapToRecord(result) : null;
  }

  async findByPositionId(
    positionId: string,
    options?: {
      status?: WalletActivityStatus;
    }
  ): Promise<PositionWalletActivityRecord[]> {
    const where: any = { positionId };

    if (options?.status) {
      where.status = options.status;
    }

    const results = await prisma.positionWalletActivity.findMany({
      where,
      orderBy: { entryTimestamp: 'asc' },
    });

    return results.map(this.mapToRecord);
  }

  async findByWalletId(
    walletId: string,
    options?: {
      status?: WalletActivityStatus;
      limit?: number;
    }
  ): Promise<PositionWalletActivityRecord[]> {
    const where: any = { walletId };

    if (options?.status) {
      where.status = options.status;
    }

    const results = await prisma.positionWalletActivity.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...(options?.limit && { take: options.limit }),
    });

    return results.map(this.mapToRecord);
  }

  async recordPartialExit(
    positionId: string,
    walletId: string,
    exitData: {
      exitTradeId?: string;
      exitPriceUsd: number;
      exitAmountUsd: number;
      exitPercent: number; // How much of position was exited (0-100)
    }
  ): Promise<PositionWalletActivityRecord | null> {
    const existing = await prisma.positionWalletActivity.findUnique({
      where: {
        positionId_walletId: { positionId, walletId },
      },
    });

    if (!existing) return null;

    const entryPrice = Number(existing.entryPriceUsd) || exitData.exitPriceUsd;
    const exitPrice = exitData.exitPriceUsd;
    const realizedPnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100;
    const realizedPnlUsd = exitData.exitAmountUsd * (realizedPnlPercent / 100);

    const newHoldingPercent = Math.max(0, Number(existing.holdingPercent) - exitData.exitPercent);
    const status: WalletActivityStatus = newHoldingPercent <= 0 ? 'full_exit' : 'partial_exit';

    const result = await prisma.positionWalletActivity.update({
      where: {
        positionId_walletId: { positionId, walletId },
      },
      data: {
        exitTradeId: exitData.exitTradeId ?? undefined,
        exitPriceUsd: exitPrice,
        exitAmountUsd: exitData.exitAmountUsd,
        exitTimestamp: new Date(),
        status,
        holdingPercent: newHoldingPercent,
        realizedPnlPercent,
        realizedPnlUsd,
        updatedAt: new Date(),
      },
    });

    return this.mapToRecord(result);
  }

  async recordFullExit(
    positionId: string,
    walletId: string,
    exitData: {
      exitTradeId?: string;
      exitPriceUsd: number;
      exitAmountUsd?: number;
    }
  ): Promise<PositionWalletActivityRecord | null> {
    const existing = await prisma.positionWalletActivity.findUnique({
      where: {
        positionId_walletId: { positionId, walletId },
      },
    });

    if (!existing) return null;

    const entryPrice = Number(existing.entryPriceUsd) || exitData.exitPriceUsd;
    const entryAmount = Number(existing.entryAmountUsd) || 0;
    const exitPrice = exitData.exitPriceUsd;
    const exitAmount = exitData.exitAmountUsd || entryAmount;

    const realizedPnlPercent = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;
    const realizedPnlUsd = exitAmount * (realizedPnlPercent / 100);

    const result = await prisma.positionWalletActivity.update({
      where: {
        positionId_walletId: { positionId, walletId },
      },
      data: {
        exitTradeId: exitData.exitTradeId ?? undefined,
        exitPriceUsd: exitPrice,
        exitAmountUsd: exitAmount,
        exitTimestamp: new Date(),
        status: 'full_exit',
        holdingPercent: 0,
        realizedPnlPercent,
        realizedPnlUsd,
        updatedAt: new Date(),
      },
    });

    return this.mapToRecord(result);
  }

  async getPositionWalletStats(positionId: string): Promise<{
    totalWallets: number;
    holdingCount: number;
    partialExitCount: number;
    fullExitCount: number;
    avgHoldingPercent: number;
    avgRealizedPnlPercent: number;
  }> {
    const activities = await prisma.positionWalletActivity.findMany({
      where: { positionId },
    });

    const holdingCount = activities.filter(a => a.status === 'holding').length;
    const partialExitCount = activities.filter(a => a.status === 'partial_exit').length;
    const fullExitCount = activities.filter(a => a.status === 'full_exit').length;

    const avgHoldingPercent = activities.length > 0
      ? activities.reduce((sum, a) => sum + Number(a.holdingPercent), 0) / activities.length
      : 0;

    const withPnl = activities.filter(a => a.realizedPnlPercent !== null);
    const avgRealizedPnlPercent = withPnl.length > 0
      ? withPnl.reduce((sum, a) => sum + (Number(a.realizedPnlPercent) || 0), 0) / withPnl.length
      : 0;

    return {
      totalWallets: activities.length,
      holdingCount,
      partialExitCount,
      fullExitCount,
      avgHoldingPercent,
      avgRealizedPnlPercent,
    };
  }

  async upsert(data: {
    positionId: string;
    walletId: string;
    entryTradeId?: string | null;
    entryPriceUsd?: number | null;
    entryAmountUsd?: number | null;
    entryTimestamp?: Date | null;
  }): Promise<PositionWalletActivityRecord> {
    const result = await prisma.positionWalletActivity.upsert({
      where: {
        positionId_walletId: {
          positionId: data.positionId,
          walletId: data.walletId,
        },
      },
      create: {
        id: generateId(),
        positionId: data.positionId,
        walletId: data.walletId,
        entryTradeId: data.entryTradeId ?? undefined,
        entryPriceUsd: data.entryPriceUsd ?? undefined,
        entryAmountUsd: data.entryAmountUsd ?? undefined,
        entryTimestamp: data.entryTimestamp ?? undefined,
        status: 'holding',
        holdingPercent: 100,
      },
      update: {
        // If already exists, don't overwrite entry data
        updatedAt: new Date(),
      },
    });

    return this.mapToRecord(result);
  }

  private mapToRecord(result: any): PositionWalletActivityRecord {
    return {
      id: result.id,
      positionId: result.positionId,
      walletId: result.walletId,
      entryTradeId: result.entryTradeId ?? null,
      entryPriceUsd: result.entryPriceUsd ? Number(result.entryPriceUsd) : null,
      entryAmountUsd: result.entryAmountUsd ? Number(result.entryAmountUsd) : null,
      entryTimestamp: result.entryTimestamp ?? null,
      exitTradeId: result.exitTradeId ?? null,
      exitPriceUsd: result.exitPriceUsd ? Number(result.exitPriceUsd) : null,
      exitAmountUsd: result.exitAmountUsd ? Number(result.exitAmountUsd) : null,
      exitTimestamp: result.exitTimestamp ?? null,
      status: result.status as WalletActivityStatus,
      holdingPercent: Number(result.holdingPercent),
      realizedPnlPercent: result.realizedPnlPercent ? Number(result.realizedPnlPercent) : null,
      realizedPnlUsd: result.realizedPnlUsd ? Number(result.realizedPnlUsd) : null,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
    };
  }
}
