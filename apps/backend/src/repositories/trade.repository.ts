import { prisma, generateId } from '../lib/prisma.js';
import { Prisma } from '@prisma/client';

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
    const skip = (page - 1) * pageSize;

    const where: Prisma.TradeWhereInput = {
      walletId,
    };

    if (params?.tokenId) {
      where.tokenId = params.tokenId;
    }

    if (params?.fromDate) {
      where.timestamp = { gte: params.fromDate };
    }

    if (params?.toDate) {
      if (!where.timestamp) {
        where.timestamp = { lte: params.toDate };
      } else {
        where.timestamp = { ...where.timestamp as any, lte: params.toDate };
      }
    }

    const [trades, total] = await Promise.all([
      prisma.trade.findMany({
        where,
        include: {
          token: true,
          wallet: {
            select: {
              id: true,
              address: true,
              label: true,
            },
          },
        },
        orderBy: { timestamp: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.trade.count({ where }),
    ]);

    return {
      trades,
      total,
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
    const existing = await this.findBySignature(data.txSignature);
    if (existing) {
      return existing;
    }

    try {
      const result = await prisma.trade.create({
        data: {
          id: generateId(),
          txSignature: data.txSignature,
          walletId: data.walletId,
          tokenId: data.tokenId,
          side: data.side,
          amountToken: data.amountToken,
          amountBase: data.amountBase,
          priceBasePerToken: data.priceBasePerToken,
          timestamp: data.timestamp,
          dex: data.dex,
          positionId: data.positionId ?? null,
          valueUsd: data.valueUsd ?? null,
          pnlUsd: data.pnlUsd ?? null,
          pnlPercent: data.pnlPercent ?? null,
          meta: data.meta ?? null,
        },
      });

      return result;
    } catch (error: any) {
      // Handle unique constraint violation (Prisma P2002)
      if (error.code === 'P2002') {
        const already = await this.findBySignature(data.txSignature);
        if (already) return already;
      }
      throw new Error(`Failed to create trade: ${error.message}`);
    }
  }

  async findAllForMetrics(walletId: string, excludeVoid: boolean = true) {
    const where: Prisma.TradeWhereInput = {
      walletId,
    };

    if (excludeVoid) {
      where.side = { in: ['buy', 'sell'] };
    }

    const trades = await prisma.trade.findMany({
      where,
      include: {
        token: true,
      },
      orderBy: { timestamp: 'asc' },
    });

    return trades;
  }

  async findById(id: string) {
    const trade = await prisma.trade.findUnique({
      where: { id },
      include: {
        token: true,
        wallet: {
          select: {
            id: true,
            address: true,
            label: true,
          },
        },
      },
    });

    return trade;
  }

  async findBySignature(txSignature: string) {
    const trade = await prisma.trade.findUnique({
      where: { txSignature },
    });

    return trade;
  }

  /**
   * Získá všechny trady (pro re-processing)
   */
  async findAll(limit?: number, offset?: number) {
    const [trades, total] = await Promise.all([
      prisma.trade.findMany({
        include: {
          wallet: {
            select: {
              id: true,
              address: true,
            },
          },
          token: {
            select: {
              id: true,
              mintAddress: true,
            },
          },
        },
        orderBy: { timestamp: 'asc' },
        ...(limit !== undefined && { take: limit }),
        ...(offset !== undefined && { skip: offset }),
      }),
      prisma.trade.count(),
    ]);

    return {
      trades,
      total,
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
      updateData.amountBase = data.amountBase;
    }
    if (data.priceBasePerToken !== undefined) {
      updateData.priceBasePerToken = data.priceBasePerToken;
    }
    if (data.valueUsd !== undefined) {
      updateData.valueUsd = data.valueUsd;
    }
    if (data.pnlUsd !== undefined) {
      updateData.pnlUsd = data.pnlUsd;
    }
    if (data.pnlPercent !== undefined) {
      updateData.pnlPercent = data.pnlPercent;
    }

    const result = await prisma.trade.update({
      where: { id: tradeId },
      data: updateData,
    });

    return result;
  }

  async deleteById(tradeId: string): Promise<void> {
    await prisma.trade.delete({
      where: { id: tradeId },
    });
  }

  async deleteByWalletAndToken(walletId: string, tokenId: string): Promise<number> {
    const result = await prisma.trade.deleteMany({
      where: {
        walletId,
        tokenId,
      },
    });

    return result.count;
  }

  async deleteByIds(tradeIds: string[]): Promise<number> {
    if (tradeIds.length === 0) {
      return 0;
    }

    const result = await prisma.trade.deleteMany({
      where: {
        id: { in: tradeIds },
      },
    });

    return result.count;
  }
}
