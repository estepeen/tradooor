import { supabase, TABLES } from '../lib/supabase.js';

export interface ConsensusSignalData {
  id?: string;
  tokenId: string;
  walletCount: number;
  firstTradeTime: string | Date;
  latestTradeTime: string | Date;
  trades: any[];
  tokenSecurity?: any | null;
}

export class ConsensusSignalRepository {
  async create(data: ConsensusSignalData) {
    const payload: any = {
      tokenId: data.tokenId,
      walletCount: data.walletCount,
      firstTradeTime: typeof data.firstTradeTime === 'string' 
        ? data.firstTradeTime 
        : data.firstTradeTime.toISOString(),
      latestTradeTime: typeof data.latestTradeTime === 'string'
        ? data.latestTradeTime
        : data.latestTradeTime.toISOString(),
      trades: data.trades,
    };
    
    if (data.tokenSecurity !== undefined) {
      payload.tokenSecurity = data.tokenSecurity;
    }

    const { data: result, error } = await supabase
      .from(TABLES.CONSENSUS_SIGNAL)
      .insert(payload)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create consensus signal: ${error.message}`);
    }

    return result;
  }

  async update(id: string, data: Partial<ConsensusSignalData>) {
    const updateData: any = {};
    
    if (data.walletCount !== undefined) updateData.walletCount = data.walletCount;
    if (data.firstTradeTime !== undefined) {
      updateData.firstTradeTime = typeof data.firstTradeTime === 'string'
        ? data.firstTradeTime
        : data.firstTradeTime.toISOString();
    }
    if (data.latestTradeTime !== undefined) {
      updateData.latestTradeTime = typeof data.latestTradeTime === 'string'
        ? data.latestTradeTime
        : data.latestTradeTime.toISOString();
    }
    if (data.trades !== undefined) updateData.trades = data.trades;
    if (data.tokenSecurity !== undefined) updateData.tokenSecurity = data.tokenSecurity;

    const { data: result, error } = await supabase
      .from(TABLES.CONSENSUS_SIGNAL)
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update consensus signal: ${error.message}`);
    }

    return result;
  }

  async findByTokenAndTimeWindow(
    tokenId: string,
    firstTradeTime: Date,
    windowMs: number = 2 * 60 * 60 * 1000 // 2 hours default
  ) {
    const windowStart = new Date(firstTradeTime.getTime() - windowMs);
    const windowEnd = new Date(firstTradeTime.getTime() + windowMs);

    const { data, error } = await supabase
      .from(TABLES.CONSENSUS_SIGNAL)
      .select('*')
      .eq('tokenId', tokenId)
      .gte('firstTradeTime', windowStart.toISOString())
      .lte('firstTradeTime', windowEnd.toISOString())
      .order('firstTradeTime', { ascending: false })
      .limit(1);

    if (error) {
      throw new Error(`Failed to find consensus signal: ${error.message}`);
    }

    return data && data.length > 0 ? data[0] : null;
  }

  async findRecent(limit: number = 100, hours: number = 1) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const { data, error } = await supabase
      .from(TABLES.CONSENSUS_SIGNAL)
      .select(`
        *,
        token:Token (
          id,
          symbol,
          name,
          mintAddress
        )
      `)
      .gte('latestTradeTime', since.toISOString())
      .order('latestTradeTime', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to find recent consensus signals: ${error.message}`);
    }

    return data || [];
  }

  async findAll(limit: number = 100) {
    const { data, error } = await supabase
      .from(TABLES.CONSENSUS_SIGNAL)
      .select(`
        *,
        token:Token (
          id,
          symbol,
          name,
          mintAddress
        )
      `)
      .order('latestTradeTime', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to find consensus signals: ${error.message}`);
    }

    return data || [];
  }
}
