import { prisma, generateId } from '../lib/prisma.js';

export type NormalizedTradeStatus = 'pending' | 'processed' | 'failed';

export interface NormalizedTradeRecord {
  id: string;
  txSignature: string;
  walletId: string;
  tokenId: string;
  tokenMint: string;
  side: 'buy' | 'sell' | 'void';
  amountToken: number;
  amountBaseRaw: number;
  baseToken: string;
  priceBasePerTokenRaw: number;
  timestamp: Date;
  dex: string;
  balanceBefore?: number | null;
  balanceAfter?: number | null;
  status: NormalizedTradeStatus;
  error?: string | null;
  meta?: Record<string, any> | null;
  rawPayload?: Record<string, any> | null;
  amountBaseUsd?: number | null;
  priceUsdPerToken?: number | null;
  valuationSource?: string | null;
  valuationTimestamp?: Date | null;
  processedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  tradeId?: string | null;
}

type CreateNormalizedTradeInput = Omit<
  NormalizedTradeRecord,
  | 'id'
  | 'status'
  | 'error'
  | 'amountBaseUsd'
  | 'priceUsdPerToken'
  | 'valuationSource'
  | 'valuationTimestamp'
  | 'processedAt'
  | 'createdAt'
  | 'updatedAt'
  | 'tradeId'
>;

export class NormalizedTradeRepository {
  async create(data: CreateNormalizedTradeInput): Promise<NormalizedTradeRecord> {
    try {
      const result = await prisma.normalizedTrade.create({
        data: {
          id: generateId(),
          txSignature: data.txSignature,
          walletId: data.walletId,
          tokenId: data.tokenId,
          tokenMint: data.tokenMint,
          side: data.side,
          amountToken: data.amountToken,
          amountBaseRaw: data.amountBaseRaw,
          baseToken: data.baseToken,
          priceBasePerTokenRaw: data.priceBasePerTokenRaw,
          timestamp: data.timestamp,
          dex: data.dex,
          balanceBefore: data.balanceBefore ?? null,
          balanceAfter: data.balanceAfter ?? null,
          meta: data.meta ?? null,
          rawPayload: data.rawPayload ?? null,
        },
      });

      return result as NormalizedTradeRecord;
    } catch (error: any) {
      // Handle unique constraint violation (Prisma P2002)
      if (error.code === 'P2002') {
        const existing = await this.findBySignatureAndWallet(data.txSignature, data.walletId, data.side);
        if (existing) return existing;
      }
      throw new Error(`Failed to create normalized trade: ${error.message}`);
    }
  }

  async findBySignatureAndWallet(
    txSignature: string,
    walletId: string,
    side: string
  ): Promise<NormalizedTradeRecord | null> {
    const result = await prisma.normalizedTrade.findFirst({
      where: {
        txSignature,
        walletId,
        side,
      },
    });

    return result as NormalizedTradeRecord | null;
  }

  async findById(id: string): Promise<NormalizedTradeRecord | null> {
    const result = await prisma.normalizedTrade.findUnique({
      where: { id },
    });

    return result as NormalizedTradeRecord | null;
  }

  async findPendingByWallet(walletId: string): Promise<NormalizedTradeRecord[]> {
    const results = await prisma.normalizedTrade.findMany({
      where: {
        walletId,
        status: 'pending',
      },
    });

    return results as NormalizedTradeRecord[];
  }

  async findPending(limit = 25): Promise<NormalizedTradeRecord[]> {
    const results = await prisma.normalizedTrade.findMany({
      where: {
        status: 'pending',
      },
      orderBy: { timestamp: 'asc' },
      take: limit,
    });

    return results as NormalizedTradeRecord[];
  }

  async markProcessed(
    id: string,
    updates: {
      tradeId: string;
      amountBaseUsd: number;
      priceUsdPerToken: number;
      valuationSource: string;
      valuationTimestamp: Date;
    }
  ) {
    await prisma.normalizedTrade.update({
      where: { id },
      data: {
        status: 'processed',
        tradeId: updates.tradeId,
        amountBaseUsd: updates.amountBaseUsd,
        priceUsdPerToken: updates.priceUsdPerToken,
        valuationSource: updates.valuationSource,
        valuationTimestamp: updates.valuationTimestamp,
        processedAt: new Date(),
      },
    });
  }

  async markFailed(id: string, errorMessage: string) {
    await prisma.normalizedTrade.update({
      where: { id },
      data: {
        status: 'failed',
        error: errorMessage,
        updatedAt: new Date(),
      },
    });
  }
}
