import prisma, { generateId } from '../lib/prisma.js';

export interface SignalRecord {
  id: string;
  type: 'buy' | 'sell';
  walletId: string;
  tokenId: string;
  originalTradeId: string | null;
  priceBasePerToken: number;
  amountBase: number | null;
  amountToken: number | null;
  timestamp: Date;
  status: 'active' | 'executed' | 'expired' | 'cancelled';
  expiresAt: Date | null;
  qualityScore: number | null;
  riskLevel: 'low' | 'medium' | 'high' | null;
  model: 'smart-copy' | 'consensus' | 'ai' | null;
  reasoning: string | null;
  meta: Record<string, any> | null;
  createdAt: Date;
  updatedAt: Date;
}

export class SignalRepository {
  async create(data: {
    type: 'buy' | 'sell';
    walletId: string;
    tokenId: string;
    originalTradeId?: string | null;
    priceBasePerToken: number;
    amountBase?: number | null;
    amountToken?: number | null;
    timestamp?: Date;
    status?: 'active' | 'executed' | 'expired' | 'cancelled';
    expiresAt?: Date | null;
    qualityScore?: number | null;
    riskLevel?: 'low' | 'medium' | 'high' | null;
    model?: 'smart-copy' | 'consensus' | 'ai' | null;
    reasoning?: string | null;
    meta?: Record<string, any> | null;
  }): Promise<SignalRecord> {
    const result = await prisma.signal.create({
      data: {
        id: generateId(),
        type: data.type,
        walletId: data.walletId,
        tokenId: data.tokenId,
        originalTradeId: data.originalTradeId || null,
        priceBasePerToken: data.priceBasePerToken,
        amountBase: data.amountBase || null,
        amountToken: data.amountToken || null,
        timestamp: data.timestamp || new Date(),
        status: data.status || 'active',
        expiresAt: data.expiresAt || null,
        qualityScore: data.qualityScore || null,
        riskLevel: data.riskLevel || null,
        model: data.model || null,
        reasoning: data.reasoning || null,
        meta: data.meta || {},
      },
    });

    return result as SignalRecord;
  }

  async findById(id: string): Promise<SignalRecord | null> {
    const result = await prisma.signal.findUnique({
      where: { id },
    });

    return result as SignalRecord | null;
  }

  async findActive(options?: {
    type?: 'buy' | 'sell';
    walletId?: string;
    tokenId?: string;
    limit?: number;
    orderBy?: 'timestamp' | 'qualityScore';
    orderDirection?: 'asc' | 'desc';
  }): Promise<SignalRecord[]> {
    const where: any = { status: 'active' };

    if (options?.type) {
      where.type = options.type;
    }

    if (options?.walletId) {
      where.walletId = options.walletId;
    }

    if (options?.tokenId) {
      where.tokenId = options.tokenId;
    }

    const orderBy = options?.orderBy || 'timestamp';
    const orderDirection = options?.orderDirection || 'desc';

    const results = await prisma.signal.findMany({
      where,
      orderBy: { [orderBy]: orderDirection },
      ...(options?.limit && { take: options.limit }),
    });

    return results as SignalRecord[];
  }

  async update(id: string, updates: {
    status?: 'active' | 'executed' | 'expired' | 'cancelled';
    expiresAt?: Date | null;
    meta?: Record<string, any> | null;
  }): Promise<SignalRecord> {
    const updateData: any = {
      updatedAt: new Date(),
    };

    if (updates.status !== undefined) {
      updateData.status = updates.status;
    }

    if (updates.expiresAt !== undefined) {
      updateData.expiresAt = updates.expiresAt;
    }

    if (updates.meta !== undefined) {
      updateData.meta = updates.meta;
    }

    const result = await prisma.signal.update({
      where: { id },
      data: updateData,
    });

    return result as SignalRecord;
  }

  async markAsExecuted(id: string): Promise<SignalRecord> {
    return this.update(id, { status: 'executed' });
  }

  async markAsExpired(id: string): Promise<SignalRecord> {
    return this.update(id, { status: 'expired' });
  }

  async expireOldSignals(maxAgeHours: number = 24): Promise<number> {
    const cutoffTime = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    
    const result = await prisma.signal.updateMany({
      where: {
        status: 'active',
        timestamp: { lt: cutoffTime },
      },
      data: {
        status: 'expired',
        updatedAt: new Date(),
      },
    });

    return result.count;
  }
}
