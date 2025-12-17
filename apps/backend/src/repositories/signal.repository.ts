import { prisma, generateId } from '../lib/prisma.js';

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
        amountBase: data.amountBase ?? undefined,
        amountToken: data.amountToken ?? undefined,
        timestamp: data.timestamp || new Date(),
        status: data.status || 'active',
        expiresAt: data.expiresAt || null,
        qualityScore: data.qualityScore ?? undefined,
        riskLevel: data.riskLevel || null,
        model: data.model || null,
        reasoning: data.reasoning || null,
        meta: (data.meta || {}) as any,
      },
    });

    return {
      id: result.id,
      type: result.type as any,
      walletId: result.walletId,
      tokenId: result.tokenId,
      originalTradeId: result.originalTradeId ?? null,
      priceBasePerToken: Number(result.priceBasePerToken),
      amountBase: result.amountBase ? Number(result.amountBase) : null,
      amountToken: result.amountToken ? Number(result.amountToken) : null,
      timestamp: result.timestamp,
      status: result.status as any,
      expiresAt: result.expiresAt ?? null,
      qualityScore: result.qualityScore ? Number(result.qualityScore) : null,
      riskLevel: (result.riskLevel as any) ?? null,
      model: (result.model as any) ?? null,
      reasoning: result.reasoning ?? null,
      meta: (result.meta as any) ?? null,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
    };
  }

  async findById(id: string): Promise<SignalRecord | null> {
    const result = await prisma.signal.findUnique({
      where: { id },
    });

    if (!result) return null;
    return {
      id: result.id,
      type: result.type as any,
      walletId: result.walletId,
      tokenId: result.tokenId,
      originalTradeId: result.originalTradeId ?? null,
      priceBasePerToken: Number(result.priceBasePerToken),
      amountBase: result.amountBase ? Number(result.amountBase) : null,
      amountToken: result.amountToken ? Number(result.amountToken) : null,
      timestamp: result.timestamp,
      status: result.status as any,
      expiresAt: result.expiresAt ?? null,
      qualityScore: result.qualityScore ? Number(result.qualityScore) : null,
      riskLevel: (result.riskLevel as any) ?? null,
      model: (result.model as any) ?? null,
      reasoning: result.reasoning ?? null,
      meta: (result.meta as any) ?? null,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
    };
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

    return results.map((result) => ({
      id: result.id,
      type: result.type as any,
      walletId: result.walletId,
      tokenId: result.tokenId,
      originalTradeId: result.originalTradeId ?? null,
      priceBasePerToken: Number(result.priceBasePerToken),
      amountBase: result.amountBase ? Number(result.amountBase) : null,
      amountToken: result.amountToken ? Number(result.amountToken) : null,
      timestamp: result.timestamp,
      status: result.status as any,
      expiresAt: result.expiresAt ?? null,
      qualityScore: result.qualityScore ? Number(result.qualityScore) : null,
      riskLevel: (result.riskLevel as any) ?? null,
      model: (result.model as any) ?? null,
      reasoning: result.reasoning ?? null,
      meta: (result.meta as any) ?? null,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
    }));
  }

  async update(id: string, updates: {
    status?: 'active' | 'executed' | 'expired' | 'cancelled';
    expiresAt?: Date | null;
    meta?: Record<string, any> | null;
    qualityScore?: number | null;
    riskLevel?: 'low' | 'medium' | 'high' | null;
    reasoning?: string | null;
    aiDecision?: string | null;
    aiConfidence?: number | null;
    aiReasoning?: string | null;
    aiSuggestedPositionPercent?: number | null;
    aiStopLossPercent?: number | null;
    aiTakeProfitPercent?: number | null;
    aiRiskScore?: number | null;
    entryPriceUsd?: number | null;
    stopLossPriceUsd?: number | null;
    takeProfitPriceUsd?: number | null;
    suggestedHoldTimeMinutes?: number | null;
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
    if (updates.qualityScore !== undefined) {
      updateData.qualityScore = updates.qualityScore;
    }
    if (updates.riskLevel !== undefined) {
      updateData.riskLevel = updates.riskLevel;
    }
    if (updates.reasoning !== undefined) {
      updateData.reasoning = updates.reasoning;
    }
    // AI fields - store in meta JSON field since they're not in Prisma schema yet
    if (updates.aiDecision !== undefined || updates.aiConfidence !== undefined || 
        updates.aiReasoning !== undefined || updates.aiSuggestedPositionPercent !== undefined ||
        updates.aiStopLossPercent !== undefined || updates.aiTakeProfitPercent !== undefined ||
        updates.aiRiskScore !== undefined || updates.entryPriceUsd !== undefined ||
        updates.stopLossPriceUsd !== undefined || updates.takeProfitPriceUsd !== undefined ||
        updates.suggestedHoldTimeMinutes !== undefined) {
      
      // Get existing meta or create new
      const existingMeta = updateData.meta || {};
      if (!updateData.meta && updates.meta) {
        Object.assign(existingMeta, updates.meta);
      }
      
      // Store AI fields in meta
      if (updates.aiDecision !== undefined) existingMeta.aiDecision = updates.aiDecision;
      if (updates.aiConfidence !== undefined) existingMeta.aiConfidence = updates.aiConfidence;
      if (updates.aiReasoning !== undefined) existingMeta.aiReasoning = updates.aiReasoning;
      if (updates.aiSuggestedPositionPercent !== undefined) existingMeta.aiSuggestedPositionPercent = updates.aiSuggestedPositionPercent;
      if (updates.aiStopLossPercent !== undefined) existingMeta.aiStopLossPercent = updates.aiStopLossPercent;
      if (updates.aiTakeProfitPercent !== undefined) existingMeta.aiTakeProfitPercent = updates.aiTakeProfitPercent;
      if (updates.aiRiskScore !== undefined) existingMeta.aiRiskScore = updates.aiRiskScore;
      if (updates.entryPriceUsd !== undefined) existingMeta.entryPriceUsd = updates.entryPriceUsd;
      if (updates.stopLossPriceUsd !== undefined) existingMeta.stopLossPriceUsd = updates.stopLossPriceUsd;
      if (updates.takeProfitPriceUsd !== undefined) existingMeta.takeProfitPriceUsd = updates.takeProfitPriceUsd;
      if (updates.suggestedHoldTimeMinutes !== undefined) existingMeta.suggestedHoldTimeMinutes = updates.suggestedHoldTimeMinutes;
      
      updateData.meta = existingMeta;
    }

    const result = await prisma.signal.update({
      where: { id },
      data: {
        ...updateData,
        meta: updates.meta !== undefined ? (updates.meta as any) : undefined,
      },
    });

    return {
      id: result.id,
      type: result.type as any,
      walletId: result.walletId,
      tokenId: result.tokenId,
      originalTradeId: result.originalTradeId ?? null,
      priceBasePerToken: Number(result.priceBasePerToken),
      amountBase: result.amountBase ? Number(result.amountBase) : null,
      amountToken: result.amountToken ? Number(result.amountToken) : null,
      timestamp: result.timestamp,
      status: result.status as any,
      expiresAt: result.expiresAt ?? null,
      qualityScore: result.qualityScore ? Number(result.qualityScore) : null,
      riskLevel: (result.riskLevel as any) ?? null,
      model: (result.model as any) ?? null,
      reasoning: result.reasoning ?? null,
      meta: (result.meta as any) ?? null,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
    };
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

  /**
   * Najde aktivní signál pro token a model (pro consensus detection)
   */
  async findActiveByTokenAndModel(tokenId: string, model: string): Promise<SignalRecord | null> {
    const result = await prisma.signal.findFirst({
      where: {
        tokenId,
        model: model as any,
        status: 'active',
      },
    });

    if (!result) return null;
    return {
      id: result.id,
      type: result.type as any,
      walletId: result.walletId,
      tokenId: result.tokenId,
      originalTradeId: result.originalTradeId ?? null,
      priceBasePerToken: Number(result.priceBasePerToken),
      amountBase: result.amountBase ? Number(result.amountBase) : null,
      amountToken: result.amountToken ? Number(result.amountToken) : null,
      timestamp: result.timestamp,
      status: result.status as any,
      expiresAt: result.expiresAt ?? null,
      qualityScore: result.qualityScore ? Number(result.qualityScore) : null,
      riskLevel: (result.riskLevel as any) ?? null,
      model: (result.model as any) ?? null,
      reasoning: result.reasoning ?? null,
      meta: (result.meta as any) ?? null,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
    };
  }
}
