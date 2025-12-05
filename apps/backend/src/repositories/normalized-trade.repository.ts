import { supabase, TABLES, generateId } from '../lib/supabase.js';

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
  private mapRow(row: any): NormalizedTradeRecord {
    return {
      id: row.id,
      txSignature: row.txSignature,
      walletId: row.walletId,
      tokenId: row.tokenId,
      tokenMint: row.tokenMint,
      side: row.side,
      amountToken: Number(row.amountToken),
      amountBaseRaw: Number(row.amountBaseRaw),
      baseToken: row.baseToken,
      priceBasePerTokenRaw: Number(row.priceBasePerTokenRaw),
      timestamp: new Date(row.timestamp),
      dex: row.dex,
      balanceBefore: row.balanceBefore ?? null,
      balanceAfter: row.balanceAfter ?? null,
      status: row.status as NormalizedTradeStatus,
      error: row.error ?? null,
      meta: row.meta ?? null,
      rawPayload: row.rawPayload ?? null,
      amountBaseUsd: row.amountBaseUsd !== null && row.amountBaseUsd !== undefined ? Number(row.amountBaseUsd) : null,
      priceUsdPerToken:
        row.priceUsdPerToken !== null && row.priceUsdPerToken !== undefined ? Number(row.priceUsdPerToken) : null,
      valuationSource: row.valuationSource ?? null,
      valuationTimestamp: row.valuationTimestamp ? new Date(row.valuationTimestamp) : null,
      processedAt: row.processedAt ? new Date(row.processedAt) : null,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      tradeId: row.tradeId ?? null,
    };
  }

  async create(data: CreateNormalizedTradeInput): Promise<NormalizedTradeRecord> {
    const payload = {
      id: generateId(),
      txSignature: data.txSignature,
      walletId: data.walletId,
      tokenId: data.tokenId,
      tokenMint: data.tokenMint,
      side: data.side,
      amountToken: data.amountToken.toString(),
      amountBaseRaw: data.amountBaseRaw.toString(),
      baseToken: data.baseToken,
      priceBasePerTokenRaw: data.priceBasePerTokenRaw.toString(),
      timestamp: data.timestamp.toISOString(),
      dex: data.dex,
      balanceBefore: data.balanceBefore ?? null,
      balanceAfter: data.balanceAfter ?? null,
      meta: data.meta ?? null,
      rawPayload: data.rawPayload ?? null,
    };

    const { data: row, error } = await supabase
      .from(TABLES.NORMALIZED_TRADE)
      .insert(payload)
      .select()
      .single();

    if (error) {
      if ((error as any).code === '23505' || /duplicate key value/i.test(error.message)) {
        const existing = await this.findBySignatureAndWallet(data.txSignature, data.walletId, data.side);
        if (existing) return existing;
      }
      throw new Error(`Failed to create normalized trade: ${error.message}`);
    }

    return this.mapRow(row);
  }

  async findBySignatureAndWallet(
    txSignature: string,
    walletId: string,
    side: string
  ): Promise<NormalizedTradeRecord | null> {
    const { data, error } = await supabase
      .from(TABLES.NORMALIZED_TRADE)
      .select('*')
      .eq('txSignature', txSignature)
      .eq('walletId', walletId)
      .eq('side', side)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to fetch normalized trade: ${error.message}`);
    }

    return this.mapRow(data);
  }

  async findById(id: string): Promise<NormalizedTradeRecord | null> {
    const { data, error } = await supabase
      .from(TABLES.NORMALIZED_TRADE)
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to fetch normalized trade: ${error.message}`);
    }

    return this.mapRow(data);
  }

  async findPendingByWallet(walletId: string): Promise<NormalizedTradeRecord[]> {
    const { data, error } = await supabase
      .from(TABLES.NORMALIZED_TRADE)
      .select('*')
      .eq('walletId', walletId)
      .eq('status', 'pending');

    if (error) {
      throw new Error(`Failed to fetch pending normalized trades: ${error.message}`);
    }

    return (data ?? []).map(row => this.mapRow(row));
  }

  async findPending(limit = 25): Promise<NormalizedTradeRecord[]> {
    const { data, error } = await supabase
      .from(TABLES.NORMALIZED_TRADE)
      .select('*')
      .eq('status', 'pending')
      .order('timestamp', { ascending: true })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to fetch pending normalized trades: ${error.message}`);
    }

    return (data ?? []).map(row => this.mapRow(row));
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
    const { error } = await supabase
      .from(TABLES.NORMALIZED_TRADE)
      .update({
        status: 'processed',
        tradeId: updates.tradeId,
        amountBaseUsd: updates.amountBaseUsd.toString(),
        priceUsdPerToken: updates.priceUsdPerToken.toString(),
        valuationSource: updates.valuationSource,
        valuationTimestamp: updates.valuationTimestamp.toISOString(),
        processedAt: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to mark normalized trade as processed: ${error.message}`);
    }
  }

  async markFailed(id: string, errorMessage: string) {
    const { error } = await supabase
      .from(TABLES.NORMALIZED_TRADE)
      .update({
        status: 'failed',
        error: errorMessage,
        updatedAt: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to mark normalized trade as failed: ${error.message}`);
    }
  }
}

