import { supabase, TABLES, generateId } from '../lib/supabase.js';

export class SmartWalletRepository {
  async findAll(params?: {
    page?: number;
    pageSize?: number;
    minScore?: number;
    tags?: string[];
    search?: string;
    sortBy?: 'score' | 'winRate' | 'recentPnl30dPercent';
    sortOrder?: 'asc' | 'desc';
  }) {
    const page = params?.page ?? 1;
    const pageSize = params?.pageSize ?? 50;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let query = supabase
      .from(TABLES.SMART_WALLET)
      .select('*', { count: 'exact' });

    // Apply filters
    if (params?.minScore !== undefined) {
      query = query.gte('score', params.minScore);
    }

    if (params?.tags && params.tags.length > 0) {
      // Supabase array overlap: tags && array['tag1', 'tag2']
      query = query.contains('tags', params.tags);
    }

    if (params?.search) {
      // Search in address or label (case-insensitive)
      query = query.or(`address.ilike.%${params.search}%,label.ilike.%${params.search}%`);
    }

    // Apply sorting
    const sortBy = params?.sortBy ?? 'score';
    const sortOrder = params?.sortOrder ?? 'desc';
    query = query.order(sortBy, { ascending: sortOrder === 'asc' });

    // Apply pagination
    query = query.range(from, to);

    const { data: wallets, error, count } = await query;

    if (error) {
      throw new Error(`Failed to fetch wallets: ${error.message}`);
    }

    // Get last trade timestamp and recent PnL in USD for each wallet
    if (wallets && wallets.length > 0) {
      const walletIds = wallets.map(w => w.id);
      
      // Fetch last trade timestamp for each wallet
      const { data: lastTrades, error: tradesError } = await supabase
        .from(TABLES.TRADE)
        .select('walletId, timestamp')
        .in('walletId', walletIds)
        .order('timestamp', { ascending: false });

      if (!tradesError && lastTrades) {
        // Create a map of walletId -> lastTradeTimestamp
        const lastTradeMap = new Map<string, Date>();
        for (const trade of lastTrades) {
          if (!lastTradeMap.has(trade.walletId)) {
            lastTradeMap.set(trade.walletId, new Date(trade.timestamp));
          }
        }

        // Add lastTradeTimestamp to each wallet
        wallets.forEach((wallet: any) => {
          wallet.lastTradeTimestamp = lastTradeMap.get(wallet.id) || null;
        });
      }

      // Calculate recent PnL in USD (last 30 days) for each wallet
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const { data: recentTrades, error: recentTradesError } = await supabase
        .from(TABLES.TRADE)
        .select('walletId, side, valueUsd, pnlUsd, timestamp')
        .in('walletId', walletIds)
        .gte('timestamp', thirtyDaysAgo.toISOString());

      if (!recentTradesError && recentTrades) {
        // Calculate PnL in USD for each wallet
        const walletPnLMap = new Map<string, { buyValue: number; sellValue: number }>();
        
        for (const trade of recentTrades) {
          if (!walletPnLMap.has(trade.walletId)) {
            walletPnLMap.set(trade.walletId, { buyValue: 0, sellValue: 0 });
          }
          
          const pnl = walletPnLMap.get(trade.walletId)!;
          const valueUsd = Number(trade.valueUsd || 0);
          
          if (trade.side === 'buy') {
            pnl.buyValue += valueUsd;
          } else if (trade.side === 'sell') {
            pnl.sellValue += valueUsd;
          }
        }

        // Add recentPnl30dUsd to each wallet
        wallets.forEach((wallet: any) => {
          const pnl = walletPnLMap.get(wallet.id);
          if (pnl) {
            wallet.recentPnl30dUsd = pnl.sellValue - pnl.buyValue;
          } else {
            wallet.recentPnl30dUsd = 0;
          }
        });
      }
    }

    return {
      wallets: wallets ?? [],
      total: count ?? 0,
      page,
      pageSize,
    };
  }

  async findById(id: string) {
    // Fetch wallet
    const { data: wallet, error: walletError } = await supabase
      .from(TABLES.SMART_WALLET)
      .select('*')
      .eq('id', id)
      .single();

    if (walletError) {
      if (walletError.code === 'PGRST116') {
        return null; // Not found
      }
      throw new Error(`Failed to fetch wallet: ${walletError.message}`);
    }

    if (!wallet) {
      return null;
    }

    // Fetch recent trades with token info
    const { data: trades, error: tradesError } = await supabase
      .from(TABLES.TRADE)
      .select(`
        *,
        token:${TABLES.TOKEN}(*)
      `)
      .eq('walletId', id)
      .order('timestamp', { ascending: false })
      .limit(10);

    if (tradesError) {
      console.warn('Failed to fetch trades for wallet:', tradesError.message);
    }

    return {
      ...wallet,
      trades: trades ?? [],
    };
  }

  async findByAddress(address: string) {
    try {
      console.log(`🔍 SmartWalletRepository.findByAddress - Searching: ${address}`);
      const { data: result, error } = await supabase
        .from(TABLES.SMART_WALLET)
        .select('*')
        .eq('address', address)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          console.log(`✅ SmartWalletRepository.findByAddress - Found: no`);
          return null; // Not found
        }
        throw error;
      }

      console.log(`✅ SmartWalletRepository.findByAddress - Found: yes`);
      return result;
    } catch (error: any) {
      console.error('❌ SmartWalletRepository.findByAddress - Error:', error?.message);
      throw error;
    }
  }

  async create(data: {
    address: string;
    label?: string;
    tags?: string[];
  }) {
    try {
      console.log('📝 SmartWalletRepository.create - Creating wallet:', data.address);
      const { data: result, error } = await supabase
        .from(TABLES.SMART_WALLET)
        .insert({
          id: generateId(),
          address: data.address,
          label: data.label ?? null,
          tags: data.tags ?? [],
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      console.log('✅ SmartWalletRepository.create - Wallet created:', result.id);
      return result;
    } catch (error: any) {
      console.error('❌ SmartWalletRepository.create - Error:');
      console.error('Error message:', error?.message);
      console.error('Error code:', error?.code);
      console.error('Error details:', error?.details);
      throw error;
    }
  }

  async update(id: string, data: Partial<{
    label: string | null;
    tags: string[];
    score: number;
    totalTrades: number;
    winRate: number;
    avgRr: number;
    avgPnlPercent: number;
    pnlTotalBase: number;
    avgHoldingTimeMin: number;
    maxDrawdownPercent: number;
    recentPnl30dPercent: number;
  }>) {
    const { data: result, error } = await supabase
      .from(TABLES.SMART_WALLET)
      .update(data)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update wallet: ${error.message}`);
    }

    return result;
  }

  async getAll(): Promise<Array<{ id: string; address: string; lastPumpfunTradeTimestamp: Date | null }>> {
    const { data: wallets, error } = await supabase
      .from(TABLES.SMART_WALLET)
      .select('id, address, lastPumpfunTradeTimestamp');

    if (error) {
      throw new Error(`Failed to fetch wallets: ${error.message}`);
    }

    return (wallets ?? []).map(w => ({
      id: w.id,
      address: w.address,
      lastPumpfunTradeTimestamp: w.lastPumpfunTradeTimestamp ? new Date(w.lastPumpfunTradeTimestamp) : null,
    }));
  }

  async getAllAddresses() {
    const { data: wallets, error } = await supabase
      .from(TABLES.SMART_WALLET)
      .select('address');

    if (error) {
      throw new Error(`Failed to fetch wallet addresses: ${error.message}`);
    }

    return wallets?.map(w => w.address) ?? [];
  }

  /**
   * Batch create wallets
   * Returns created wallets and errors
   */
  async createBatch(wallets: Array<{
    address: string;
    label?: string | null;
    tags?: string[];
  }>) {
    if (wallets.length === 0) {
      return { created: [], errors: [] };
    }

    // Remove duplicates from input (keep first occurrence)
    const seenAddresses = new Set<string>();
    const uniqueWallets = wallets.filter(w => {
      if (seenAddresses.has(w.address)) {
        return false;
      }
      seenAddresses.add(w.address);
      return true;
    });

    // Check which wallets already exist
    // Supabase .in() has a limit, so we'll check in batches of 100
    const addresses = uniqueWallets.map(w => w.address);
    const existingAddresses = new Set<string>();
    const BATCH_SIZE = 100;

    for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
      const batch = addresses.slice(i, i + BATCH_SIZE);
      const { data: existing, error: fetchError } = await supabase
        .from(TABLES.SMART_WALLET)
        .select('address')
        .in('address', batch);

      if (fetchError) {
        console.warn(`⚠️  Error checking batch ${i}-${i + batch.length}: ${fetchError.message}`);
        // Continue with other batches
        continue;
      }

      existing?.forEach(w => existingAddresses.add(w.address));
    }
    const walletsToCreate = uniqueWallets.filter(w => !existingAddresses.has(w.address));

    if (walletsToCreate.length === 0) {
      return {
        created: [],
        errors: uniqueWallets.map(w => ({
          address: w.address,
          error: 'Wallet already exists',
        })),
      };
    }

    // Prepare data for batch insert
    const dataToInsert = walletsToCreate.map(w => ({
      id: generateId(),
      address: w.address,
      label: w.label ?? null,
      tags: w.tags ?? [],
    }));

    // Batch insert - handle potential duplicates gracefully
    const { data: created, error: insertError } = await supabase
      .from(TABLES.SMART_WALLET)
      .insert(dataToInsert)
      .select();

    if (insertError) {
      // If it's a duplicate key error, try inserting one by one to find which ones failed
      if (insertError.code === '23505' || insertError.message.includes('duplicate key')) {
        console.warn('⚠️  Duplicate key error during batch insert, trying individual inserts...');
        const createdWallets: any[] = [];
        const errorWallets: Array<{ address: string; error: string }> = [];

        for (const wallet of walletsToCreate) {
          try {
            const { data: singleCreated, error: singleError } = await supabase
              .from(TABLES.SMART_WALLET)
              .insert({
                id: generateId(),
                address: wallet.address,
                label: wallet.label ?? null,
                tags: wallet.tags ?? [],
              })
              .select()
              .single();

            if (singleError) {
              if (singleError.code === '23505' || singleError.message.includes('duplicate key')) {
                errorWallets.push({
                  address: wallet.address,
                  error: 'Wallet already exists',
    });
              } else {
                errorWallets.push({
                  address: wallet.address,
                  error: singleError.message,
                });
              }
            } else if (singleCreated) {
              createdWallets.push(singleCreated);
            }
          } catch (err: any) {
            errorWallets.push({
              address: wallet.address,
              error: err.message || 'Unknown error',
            });
          }
        }

        // Prepare errors for existing wallets
        const existingErrors = uniqueWallets
          .filter(w => existingAddresses.has(w.address))
          .map(w => ({
            address: w.address,
            error: 'Wallet already exists',
          }));

        return {
          created: createdWallets,
          errors: [...existingErrors, ...errorWallets],
        };
      }
      throw new Error(`Failed to create wallets: ${insertError.message}`);
    }

    // Prepare errors for existing wallets
    const errors = uniqueWallets
      .filter(w => existingAddresses.has(w.address))
      .map(w => ({
        address: w.address,
        error: 'Wallet already exists',
      }));

    return {
      created: created ?? [],
      errors,
    };
  }

  async updateLastPumpfunTimestamp(walletId: string, timestamp: Date): Promise<void> {
    const { error } = await supabase
      .from(TABLES.SMART_WALLET)
      .update({ lastPumpfunTradeTimestamp: timestamp.toISOString() })
      .eq('id', walletId);

    if (error) {
      throw new Error(`Failed to update lastPumpfunTradeTimestamp: ${error.message}`);
    }
  }

  async delete(walletId: string): Promise<void> {
    const { error } = await supabase
      .from(TABLES.SMART_WALLET)
      .delete()
      .eq('id', walletId);

    if (error) {
      throw new Error(`Failed to delete wallet: ${error.message}`);
    }
  }
}
