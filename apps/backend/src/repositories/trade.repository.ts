import { prisma } from '@solbot/db';
import type { Prisma } from '@solbot/db';

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

    if (params?.fromDate || params?.toDate) {
      where.timestamp = {};
      if (params.fromDate) {
        where.timestamp.gte = params.fromDate;
      }
      if (params.toDate) {
        where.timestamp.lte = params.toDate;
      }
    }

    const [trades, total] = await Promise.all([
      prisma.trade.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { timestamp: 'desc' },
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
      }) as Promise<any[]>,
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
    side: 'buy' | 'sell';
    amountToken: number;
    amountBase: number;
    priceBasePerToken: number;
    timestamp: Date;
    dex: string;
    positionId?: string;
    meta?: Record<string, any>;
  }) {
    return prisma.trade.create({
      data: {
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
        meta: data.meta ?? null,
      },
    });
  }

  async findAllForMetrics(walletId: string) {
    return prisma.trade.findMany({
      where: { walletId },
      include: { token: true },
      orderBy: { timestamp: 'asc' },
    }) as Promise<any[]>;
  }
}

