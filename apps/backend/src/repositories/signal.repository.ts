import { supabase, TABLES, generateId } from '../lib/supabase.js';

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

const toNumber = (value: any) => (value === null || value === undefined ? 0 : Number(value));

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
    const id = generateId();
    const now = new Date();

    const { data: result, error } = await supabase
      .from('Signal')
      .insert({
        id,
        type: data.type,
        walletId: data.walletId,
        tokenId: data.tokenId,
        originalTradeId: data.originalTradeId || null,
        priceBasePerToken: data.priceBasePerToken.toString(),
        amountBase: data.amountBase ? data.amountBase.toString() : null,
        amountToken: data.amountToken ? data.amountToken.toString() : null,
        timestamp: (data.timestamp || now).toISOString(),
        status: data.status || 'active',
        expiresAt: data.expiresAt ? data.expiresAt.toISOString() : null,
        qualityScore: data.qualityScore ? data.qualityScore.toString() : null,
        riskLevel: data.riskLevel || null,
        model: data.model || null,
        reasoning: data.reasoning || null,
        meta: data.meta || {},
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create signal: ${error.message}`);
    }

    return this.mapRow(result);
  }

  async findById(id: string): Promise<SignalRecord | null> {
    const { data, error } = await supabase
      .from('Signal')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`Failed to find signal: ${error.message}`);
    }

    return data ? this.mapRow(data) : null;
  }

  async findActive(options?: {
    type?: 'buy' | 'sell';
    walletId?: string;
    tokenId?: string;
    limit?: number;
    orderBy?: 'timestamp' | 'qualityScore';
    orderDirection?: 'asc' | 'desc';
  }): Promise<SignalRecord[]> {
    let query = supabase
      .from('Signal')
      .select('*')
      .eq('status', 'active');

    if (options?.type) {
      query = query.eq('type', options.type);
    }

    if (options?.walletId) {
      query = query.eq('walletId', options.walletId);
    }

    if (options?.tokenId) {
      query = query.eq('tokenId', options.tokenId);
    }

    const orderBy = options?.orderBy || 'timestamp';
    const orderDirection = options?.orderDirection || 'desc';
    query = query.order(orderBy, { ascending: orderDirection === 'asc' });

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    const { data, error } = await query;

    if (error) {
      // Table might not exist yet
      if (error.code === '42P01' || /does not exist/i.test(error.message)) {
        console.warn('⚠️  Signal table does not exist yet. Run ADD_SIGNALS.sql migration.');
        return [];
      }
      throw new Error(`Failed to find active signals: ${error.message}`);
    }

    return (data || []).map(row => this.mapRow(row));
  }

  async update(id: string, updates: {
    status?: 'active' | 'executed' | 'expired' | 'cancelled';
    expiresAt?: Date | null;
    meta?: Record<string, any> | null;
  }): Promise<SignalRecord> {
    const updateData: any = {
      updatedAt: new Date().toISOString(),
    };

    if (updates.status !== undefined) {
      updateData.status = updates.status;
    }

    if (updates.expiresAt !== undefined) {
      updateData.expiresAt = updates.expiresAt ? updates.expiresAt.toISOString() : null;
    }

    if (updates.meta !== undefined) {
      updateData.meta = updates.meta;
    }

    const { data, error } = await supabase
      .from('Signal')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update signal: ${error.message}`);
    }

    return this.mapRow(data);
  }

  async markAsExecuted(id: string): Promise<SignalRecord> {
    return this.update(id, { status: 'executed' });
  }

  async markAsExpired(id: string): Promise<SignalRecord> {
    return this.update(id, { status: 'expired' });
  }

  async expireOldSignals(maxAgeHours: number = 24): Promise<number> {
    const cutoffTime = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    
    const { data, error } = await supabase
      .from('Signal')
      .update({
        status: 'expired',
        updatedAt: new Date().toISOString(),
      })
      .eq('status', 'active')
      .lt('timestamp', cutoffTime.toISOString())
      .select();

    if (error) {
      throw new Error(`Failed to expire old signals: ${error.message}`);
    }

    return data?.length || 0;
  }

  private mapRow(row: any): SignalRecord {
    return {
      id: row.id,
      type: row.type,
      walletId: row.walletId,
      tokenId: row.tokenId,
      originalTradeId: row.originalTradeId,
      priceBasePerToken: toNumber(row.priceBasePerToken),
      amountBase: row.amountBase ? toNumber(row.amountBase) : null,
      amountToken: row.amountToken ? toNumber(row.amountToken) : null,
      timestamp: new Date(row.timestamp),
      status: row.status,
      expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
      qualityScore: row.qualityScore ? toNumber(row.qualityScore) : null,
      riskLevel: row.riskLevel,
      model: row.model,
      reasoning: row.reasoning,
      meta: row.meta || {},
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }
}
