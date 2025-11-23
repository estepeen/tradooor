import { supabase, TABLES, generateId } from '../lib/supabase.js';
import { BinancePriceService } from '../services/binance-price.service.js';

export class SmartWalletRepository {
  async findAll(params?: {
    page?: number;
    pageSize?: number;
    minScore?: number;
    tags?: string[];
    search?: string;
    sortBy?: 'score' | 'winRate' | 'recentPnl30dPercent' | 'totalTrades' | 'lastTradeTimestamp' | 'label' | 'address';
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
    // Note: lastTradeTimestamp and recentPnl30dUsd are calculated after DB query,
    // so they need client-side sorting (handled in frontend)
    const sortBy = params?.sortBy ?? 'score';
    const sortOrder = params?.sortOrder ?? 'desc';
    
    // Only apply DB sorting for fields that exist in the database
    if (sortBy !== 'lastTradeTimestamp' && sortBy !== 'recentPnl30dUsd') {
    query = query.order(sortBy, { ascending: sortOrder === 'asc' });
    }

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
        // Create a map of walletId -> lastTradeTimestamp (as ISO string for proper JSON serialization)
        const lastTradeMap = new Map<string, string>();
        for (const trade of lastTrades) {
          if (!lastTradeMap.has(trade.walletId)) {
            // Convert to ISO string to ensure proper JSON serialization
            const timestamp = trade.timestamp instanceof Date 
              ? trade.timestamp.toISOString()
              : new Date(trade.timestamp).toISOString();
            lastTradeMap.set(trade.walletId, timestamp);
          }
        }

        // Add lastTradeTimestamp to each wallet (as ISO string)
        wallets.forEach((wallet: any) => {
          wallet.lastTradeTimestamp = lastTradeMap.get(wallet.id) || null;
        });
      }

      // Calculate recent PnL in USD (last 30 days) from Closed Positions for each wallet
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      // Get all trades for all wallets (needed to calculate closed positions)
      // IMPORTANT: Include all trade types (buy, sell, add, remove) to match portfolio endpoint logic
      // IMPORTANT: Fetch ALL trades for ALL wallets on the page, not just the first batch
      const { data: allTrades, error: allTradesError } = await supabase
        .from(TABLES.TRADE)
        .select('walletId, tokenId, side, amountToken, amountBase, priceBasePerToken, timestamp, meta, id, valueUsd')
        .in('walletId', walletIds);

      // DEBUG: Log which wallets have trades
      if (allTrades) {
        const walletsWithTrades = new Set(allTrades.map((t: any) => t.walletId));
        const walletsWithoutTrades = walletIds.filter(id => !walletsWithTrades.has(id));
        if (walletsWithoutTrades.length > 0) {
          console.log(`   ⚠️  [Repository] Wallets without trades: ${walletsWithoutTrades.map(id => {
            const wallet = wallets.find((w: any) => w.id === id);
            return wallet?.address || id;
          }).join(', ')}`);
        }
        console.log(`   📊 [Repository] Fetched ${allTrades.length} trades for ${walletsWithTrades.size} wallets (total wallets on page: ${walletIds.length})`);
      }

      if (!allTradesError && allTrades) {
        // Calculate closed positions and PnL for each wallet
        const walletPnLMap = new Map<string, { pnlUsd: number; pnlPercent: number }>();
        
        // Group trades by wallet
        const tradesByWallet = new Map<string, typeof allTrades>();
        for (const trade of allTrades) {
          if (!tradesByWallet.has(trade.walletId)) {
            tradesByWallet.set(trade.walletId, []);
          }
          tradesByWallet.get(trade.walletId)!.push(trade);
        }
        
        // Get current SOL price for USD conversion (once for all wallets)
        const binancePriceService = new BinancePriceService();
        const currentSolPrice = await binancePriceService.getCurrentSolPrice().catch(() => 150); // Fallback to $150 if API fails
        
        // Calculate closed positions for each wallet
        for (const [walletId, walletTrades] of tradesByWallet.entries()) {
          // DEBUG: Log wallet being processed
          const walletAddress = wallets.find((w: any) => w.id === walletId)?.address || 'unknown';
          const isDebugWallet = walletAddress === 'EHg5YkU2SZBTvuT87rUsvxArGp3HLeye1fXaSDfuMyaf';
          if (isDebugWallet) {
            console.log(`   🔍 [Repository] DEBUG: Processing wallet ${walletAddress} (${walletId}): ${walletTrades.length} trades`);
          } else {
            console.log(`   🔍 [Repository] Processing wallet ${walletAddress} (${walletId}): ${walletTrades.length} trades`);
          }
          
          // Calculate positions from trades (same as portfolio endpoint)
          const positionMap = new Map<string, {
            tokenId: string;
            totalBought: number;
            totalSold: number;
            balance: number;
            totalInvested: number; // For backward compatibility (USD)
            totalSoldValue: number; // For backward compatibility (USD)
            totalCostBase: number;
            totalProceedsBase: number;
            buyCount: number;
            sellCount: number;
            firstBuyTimestamp: Date | null;
            lastSellTimestamp: Date | null;
            baseToken: string;
          }>();
          
          // Get valueUsd for trades (needed for totalInvested and totalSoldValue)
          // Use valueUsd from allTrades if available (we already fetched it)
          let valueUsdMap = new Map<string, number>();
          for (const trade of walletTrades) {
            const tradeId = (trade as any).id;
            const valueUsd = (trade as any).valueUsd;
            if (tradeId && valueUsd !== undefined) {
              valueUsdMap.set(tradeId, Number(valueUsd || 0));
            }
          }
          
          // Fallback: fetch valueUsd if not in allTrades
          const tradeIds = walletTrades.map(t => (t as any).id).filter(Boolean);
          const missingValueUsdIds = tradeIds.filter(id => !valueUsdMap.has(id));
          if (missingValueUsdIds.length > 0) {
            const { data: tradesWithValue } = await supabase
              .from(TABLES.TRADE)
              .select('id, valueUsd, side')
              .in('id', missingValueUsdIds);
            
            if (tradesWithValue) {
              for (const t of tradesWithValue) {
                valueUsdMap.set(t.id, Number(t.valueUsd || 0));
              }
            }
          }
          
          // Sort trades chronologically
          const sortedTrades = [...walletTrades].sort((a, b) => 
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
          );
          
          for (const trade of sortedTrades) {
            const tokenId = trade.tokenId;
            const amount = Number(trade.amountToken || 0);
            const amountBase = Number(trade.amountBase || 0);
            const baseToken = (trade.meta as any)?.baseToken || 'SOL';
            const tradeTimestamp = new Date(trade.timestamp);
            const valueUsd = valueUsdMap.get((trade as any).id) || 0;
            const price = Number(trade.priceBasePerToken || 0);
            const value = amount * price; // Fallback if valueUsd is not available
            
            if (!positionMap.has(tokenId)) {
              positionMap.set(tokenId, {
                tokenId,
                totalBought: 0,
                totalSold: 0,
                balance: 0,
                totalInvested: 0,
                totalSoldValue: 0,
                totalCostBase: 0,
                totalProceedsBase: 0,
                buyCount: 0,
                sellCount: 0,
                firstBuyTimestamp: null,
                lastSellTimestamp: null,
                baseToken,
              });
            }
            
            const position = positionMap.get(tokenId)!;
            
            if (trade.side === 'buy' || trade.side === 'add') {
              position.totalBought += amount;
              position.balance += amount;
              position.totalCostBase += amountBase;
              position.totalInvested += valueUsd || value;
              position.buyCount++;
              if (!position.firstBuyTimestamp || tradeTimestamp < position.firstBuyTimestamp) {
                position.firstBuyTimestamp = tradeTimestamp;
              }
            } else if (trade.side === 'sell' || trade.side === 'remove') {
              position.totalSold += amount;
              position.balance -= amount;
              position.totalProceedsBase += amountBase;
              position.totalSoldValue += valueUsd || value;
              position.sellCount++;
              if (!position.lastSellTimestamp || tradeTimestamp > position.lastSellTimestamp) {
                position.lastSellTimestamp = tradeTimestamp;
              }
            }
          }
          
          // Calculate closed positions with holdTimeMinutes (same as portfolio endpoint)
          const closedPositions = Array.from(positionMap.values())
            .map(p => {
              // Treat small negative balance (rounding errors) as 0
              const normalizedBalance = p.balance < 0 && Math.abs(p.balance) < 0.0001 ? 0 : p.balance;
              
              // Calculate hold time for closed positions (from first BUY to last SELL)
              let holdTimeMinutes: number | null = null;
              if (p.firstBuyTimestamp && p.lastSellTimestamp && normalizedBalance <= 0) {
                const holdTimeMs = p.lastSellTimestamp.getTime() - p.firstBuyTimestamp.getTime();
                holdTimeMinutes = Math.round(holdTimeMs / (1000 * 60));
                // Allow 0 minutes (same timestamp) - it's still a valid closed position
                if (holdTimeMinutes < 0) {
                  holdTimeMinutes = null; // Invalid if SELL is before BUY
                }
              }
              
              return {
                ...p,
                normalizedBalance,
                holdTimeMinutes,
              };
            })
            .filter(p => {
              // Same filters as portfolio endpoint
              if (p.normalizedBalance > 0) return false;
              if (p.buyCount === 0) return false;
              if (p.sellCount === 0) return false;
              if (!p.firstBuyTimestamp || !p.lastSellTimestamp) return false;
              if (p.holdTimeMinutes === null || p.holdTimeMinutes < 0) return false;
              // Must have some PnL data
              if (!p.totalCostBase && !p.totalProceedsBase) return false;
              return true;
            });
          
          // Filter closed positions by lastSellTimestamp (last 30 days)
          const recentClosedPositions = closedPositions.filter(p => {
            if (!p.lastSellTimestamp) return false;
            const sellDate = new Date(p.lastSellTimestamp);
            return sellDate >= thirtyDaysAgo && sellDate <= new Date();
          });
          
          // DEBUG: Log closed positions calculation
          if (isDebugWallet) {
            console.log(`   📊 [Repository] DEBUG: Wallet ${walletAddress} (${walletId}): Found ${closedPositions.length} total closed positions, ${recentClosedPositions.length} in last 30 days`);
            console.log(`   📊 [Repository] DEBUG: Closed positions details:`);
            closedPositions.forEach((p, idx) => {
              const isRecent = p.lastSellTimestamp && new Date(p.lastSellTimestamp) >= thirtyDaysAgo;
              console.log(`      ${idx + 1}. tokenId=${p.tokenId}, balance=${p.normalizedBalance}, buyCount=${p.buyCount}, sellCount=${p.sellCount}, holdTime=${p.holdTimeMinutes}, lastSell=${p.lastSellTimestamp}, isRecent=${isRecent}`);
            });
          } else if (walletId && recentClosedPositions.length > 0) {
            console.log(`   📊 [Repository] Wallet ${walletId}: Found ${closedPositions.length} total closed positions, ${recentClosedPositions.length} in last 30 days`);
          }
          
          // Calculate total PnL from closed positions (EXACT same logic as portfolio endpoint)
          // Portfolio endpoint logic: sum closedPnl, calculate totalCost from closedPnl and closedPnlPercent, then pnlPercent = (totalPnl / totalCost) * 100
          
          // First, calculate closedPnl and closedPnlPercent for each position (same as portfolio endpoint does)
          const positionsWithPnL = recentClosedPositions.map((position: any) => {
            let closedPnlUsd = 0;
            let closedPnlPercent: number | null = null;
            
            // Calculate PnL in base currency (same as portfolio endpoint)
            if (position.totalProceedsBase > 0 && position.totalCostBase > 0) {
              const closedPnlBase = position.totalProceedsBase - position.totalCostBase;
              
              // Convert to USD using current SOL price (same as portfolio endpoint)
              if (currentSolPrice) {
                if (position.baseToken === 'SOL') {
                  closedPnlUsd = closedPnlBase * currentSolPrice;
                } else if (position.baseToken === 'USDC' || position.baseToken === 'USDT') {
                  closedPnlUsd = closedPnlBase; // 1:1 with USD
                } else {
                  // Fallback: use SOL price
                  closedPnlUsd = closedPnlBase * currentSolPrice;
                }
              }
              
              // Calculate percentage
              closedPnlPercent = position.totalCostBase > 0
                ? (closedPnlBase / position.totalCostBase) * 100
                : null;
            } else if (position.totalSoldValue > 0) {
              // Fallback to old calculation if we don't have base currency data (same as portfolio endpoint)
              closedPnlUsd = position.totalSoldValue - position.totalInvested;
              closedPnlPercent = position.totalInvested > 0
                ? (closedPnlUsd / position.totalInvested) * 100
                : null;
            }
            
            return {
              ...position,
              closedPnl: closedPnlUsd,
              closedPnlPercent,
            };
          });
          
          // Now use EXACT same logic as portfolio endpoint (lines 1532-1542)
          const totalPnl30d = positionsWithPnL.reduce((sum: number, p: any) => sum + (p.closedPnl ?? 0), 0);
          const totalCost30d = positionsWithPnL.reduce((sum: number, p: any) => {
            const pnl = p.closedPnl ?? 0;
            const pnlPercent = p.closedPnlPercent ?? 0;
            if (pnlPercent !== 0 && typeof pnl === 'number' && typeof pnlPercent === 'number') {
              const cost = pnl / (pnlPercent / 100);
              return sum + Math.abs(cost);
            }
            return sum;
          }, 0);
          const pnlPercent30d = totalCost30d > 0 ? (totalPnl30d / totalCost30d) * 100 : 0;
          
          // DEBUG: Log final PnL calculation
          if (walletId) {
            console.log(`   ✅ [Repository] Wallet ${walletId}: totalPnl30d=${totalPnl30d.toFixed(2)}, totalCost30d=${totalCost30d.toFixed(2)}, pnlPercent30d=${pnlPercent30d.toFixed(2)}%`);
            if (isDebugWallet) {
              positionsWithPnL.forEach((p: any, idx: number) => {
                console.log(`      ${idx + 1}. tokenId=${p.tokenId}, closedPnl=${p.closedPnl?.toFixed(2) || 'null'}, closedPnlPercent=${p.closedPnlPercent?.toFixed(2) || 'null'}%`);
              });
            }
          }
          
          walletPnLMap.set(walletId, {
            pnlUsd: totalPnl30d,
            pnlPercent: pnlPercent30d,
          });
        }

        // Add recentPnl30dUsd and recentPnl30dPercent to each wallet
        // IMPORTANT: Ensure ALL wallets on the page get PnL values, even if 0
        wallets.forEach((wallet: any) => {
          const pnl = walletPnLMap.get(wallet.id);
          
          if (pnl) {
            wallet.recentPnl30dUsd = pnl.pnlUsd;
            wallet.recentPnl30dPercent = pnl.pnlPercent;
            // DEBUG: Log all wallets with non-zero PnL
            if (Math.abs(pnl.pnlUsd) > 0.01 || Math.abs(pnl.pnlPercent) > 0.01) {
              console.log(`   ✅ [Repository] Wallet ${wallet.address}: PnL set to ${pnl.pnlUsd.toFixed(2)} USD (${pnl.pnlPercent.toFixed(2)}%)`);
            }
          } else {
            // IMPORTANT: Set to 0 (not undefined/null) for wallets without PnL
            wallet.recentPnl30dUsd = 0;
            wallet.recentPnl30dPercent = 0;
            // DEBUG: Log wallets without PnL (but only if they have trades)
            const hasTrades = tradesByWallet.has(wallet.id);
            if (hasTrades) {
              const tradeCount = tradesByWallet.get(wallet.id)?.length || 0;
              console.log(`   ⚠️  [Repository] Wallet ${wallet.address}: No PnL calculated (has ${tradeCount} trades, but no closed positions in last 30 days)`);
            }
          }
        });
        
        // DEBUG: Log summary
        const walletsWithPnL = wallets.filter((w: any) => Math.abs(w.recentPnl30dUsd || 0) > 0.01 || Math.abs(w.recentPnl30dPercent || 0) > 0.01);
        console.log(`   📊 [Repository] Summary: ${walletsWithPnL.length}/${wallets.length} wallets have non-zero PnL`);
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
