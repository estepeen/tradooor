/**
 * FIFO Lot-Matching Service
 * 
 * Implements FIFO (First-In-First-Out) lot matching algorithm for accurate PnL and hold time calculation.
 * Handles:
 * - DCA (multiple buys before sell)
 * - Partial sells
 * - Pre-history trades (synthetic lots)
 */

import { supabase, TABLES } from '../lib/supabase.js';
import { TradeFeatureRepository } from '../repositories/trade-feature.repository.js';

interface Lot {
  remainingSize: number;
  entryPrice: number;
  entryTime: Date;
  tradeId: string;
  isSynthetic?: boolean; // True if created from pre-history
  costKnown?: boolean; // False for pre-history lots
}

interface ClosedLot {
  walletId: string;
  tokenId: string;
  size: number;
  entryPrice: number;
  exitPrice: number;
  entryTime: Date;
  exitTime: Date;
  holdTimeMinutes: number;
  costBasis: number;
  proceeds: number;
  realizedPnl: number;
  realizedPnlPercent: number;
  realizedPnlUsd?: number; // USD value at time of closure (fixed, doesn't change with SOL price)
  buyTradeId: string;
  sellTradeId: string;
  isPreHistory: boolean;
  costKnown: boolean;
}

type RealizedAggregate = {
  totalPnl: number;
  totalCost: number;
  totalHoldSeconds: number;
  totalSize: number;
};

export class LotMatchingService {
  private tradeFeatureRepo: TradeFeatureRepository;

  constructor(tradeFeatureRepo: TradeFeatureRepository = new TradeFeatureRepository()) {
    this.tradeFeatureRepo = tradeFeatureRepo;
  }
  /**
   * Process trades and create closed lots using FIFO matching
   * 
   * @param walletId - Wallet ID
   * @param tokenId - Token ID (optional, if not provided, processes all tokens)
   * @param trackingStartTime - When tracking started (for pre-history detection)
   */
  async processTradesForWallet(
    walletId: string,
    tokenId?: string,
    trackingStartTime?: Date
  ): Promise<ClosedLot[]> {
    // Get all trades for this wallet (and token if specified)
    let query = supabase
      .from(TABLES.TRADE)
      .select('*')
      .eq('walletId', walletId)
      .order('timestamp', { ascending: true });

    if (tokenId) {
      query = query.eq('tokenId', tokenId);
    }

    const { data: trades, error } = await query;

    if (error) {
      throw new Error(`Failed to fetch trades: ${error.message}`);
    }

    if (!trades || trades.length === 0) {
      return [];
    }

    // Group trades by token
    const tradesByToken = new Map<string, typeof trades>();
    for (const trade of trades) {
      const tid = trade.tokenId;
      if (!tradesByToken.has(tid)) {
        tradesByToken.set(tid, []);
      }
      tradesByToken.get(tid)!.push(trade);
    }

    const allClosedLots: ClosedLot[] = [];

    // Process each token separately
    for (const [tid, tokenTrades] of tradesByToken.entries()) {
      const closedLots = this.processTradesForToken(
        walletId,
        tid,
        tokenTrades,
        trackingStartTime
      );
      allClosedLots.push(...closedLots);
    }

    return allClosedLots;
  }

  /**
   * Process trades for a single token using FIFO matching
   */
  private processTradesForToken(
    walletId: string,
    tokenId: string,
    trades: any[],
    trackingStartTime?: Date
  ): ClosedLot[] {
    const openLots: Lot[] = [];
    const closedLots: ClosedLot[] = [];

    // Minimální hodnota v base měně pro považování za reálný trade
    const MIN_BASE_VALUE = 0.0001;

    for (const trade of trades) {
      const side = trade.side;
      const amount = Number(trade.amountToken);
      const price = Number(trade.priceBasePerToken);
      const amountBase = Number(trade.amountBase || 0);
      const timestamp = new Date(trade.timestamp);

      // Filtruj airdropy/transfery
      if (side === 'buy' && amountBase < MIN_BASE_VALUE) {
        continue;
      }
      if (price <= 0 || price < MIN_BASE_VALUE / amount) {
        continue;
      }

      if (side === 'buy') {
        // BUY: Add new lot
        openLots.push({
          remainingSize: amount,
          entryPrice: price,
          entryTime: timestamp,
          tradeId: trade.id,
          isSynthetic: false,
          costKnown: true,
        });
      } else if (side === 'sell') {
        // SELL: Match against open lots using FIFO
        let toSell = amount;

        while (toSell > 0 && openLots.length > 0) {
          const lot = openLots[0]; // FIFO: take first lot
          const consumed = Math.min(toSell, lot.remainingSize);

          const costBasis = consumed * lot.entryPrice;
          const proceeds = consumed * price;
          const realizedPnl = proceeds - costBasis;
          const realizedPnlPercent = lot.costKnown && costBasis > 0
            ? (realizedPnl / costBasis) * 100
            : 0;

          const holdTimeMinutes = Math.round(
            (timestamp.getTime() - lot.entryTime.getTime()) / (1000 * 60)
          );

          // Create closed lot
          closedLots.push({
            walletId,
            tokenId,
            size: consumed,
            entryPrice: lot.entryPrice,
            exitPrice: price,
            entryTime: lot.entryTime,
            exitTime: timestamp,
            holdTimeMinutes,
            costBasis,
            proceeds,
            realizedPnl,
            realizedPnlPercent,
            buyTradeId: lot.tradeId,
            sellTradeId: trade.id,
            isPreHistory: lot.isSynthetic || false,
            costKnown: lot.costKnown !== false, // Default to true
          });

          // Update lot
          lot.remainingSize -= consumed;
          if (lot.remainingSize <= 0.00000001) { // Small epsilon for floating point
            openLots.shift(); // Remove fully consumed lot
          }

          toSell -= consumed;
        }

        // If we still have tokens to sell but no open lots, this is a SELL without BUY (pre-history)
        // DŮLEŽITÉ: NEPŘIDÁVÁME synthetic lots do closedLots, protože:
        // 1. Neznáme cost basis (PnL = 0, nemá smysl zobrazovat)
        // 2. Nevíme, kdy byl skutečný buy (hold time je nepřesný)
        // 3. Closed positions by měly obsahovat jen kompletní trades (BUY + SELL)
        // Pokud chceme trackovat sell bez buy, měl by se použít jiný mechanismus
        if (toSell > 0) {
          console.log(`   ⚠️  SELL without matching BUY for token ${tokenId}: ${toSell} tokens sold at ${price} - skipping (pre-history, no cost basis)`);
          // Nepřidáváme do closedLots - není to kompletní trade
        }
      }
    }

    return closedLots;
  }

  /**
   * Save closed lots to database
   */
  async saveClosedLots(closedLots: ClosedLot[]): Promise<void> {
    if (closedLots.length === 0) {
      return;
    }

    // Get current SOL price for USD conversion (use current price as approximation for exit time)
    // This ensures realizedPnlUsd is fixed at time of lot creation, not recalculated later
    let solPriceUsd = 1; // Fallback
    try {
      const { BinancePriceService } = await import('./binance-price.service.js');
      const binancePriceService = new BinancePriceService();
      solPriceUsd = await binancePriceService.getCurrentSolPrice();
    } catch (error) {
      console.warn('⚠️  Failed to fetch SOL price for realizedPnlUsd, using fallback:', (error as any)?.message || error);
    }

    // Convert to database format
    const dbLots = closedLots.map(lot => {
      // Calculate realizedPnlUsd if not already set (use SOL price for SOL-based trades)
      // For USDC/USDT, realizedPnl is already in USD (1:1)
      let realizedPnlUsd = lot.realizedPnlUsd;
      if (realizedPnlUsd === undefined) {
        // Assume SOL-based trade (most common)
        // TODO: Detect baseToken from trade meta if available
        realizedPnlUsd = lot.realizedPnl * solPriceUsd;
      }

      return {
        walletId: lot.walletId,
        tokenId: lot.tokenId,
        size: lot.size.toString(),
        entryPrice: lot.entryPrice.toString(),
        exitPrice: lot.exitPrice.toString(),
        entryTime: lot.entryTime.toISOString(),
        exitTime: lot.exitTime.toISOString(),
        holdTimeMinutes: lot.holdTimeMinutes,
        costBasis: lot.costBasis.toString(),
        proceeds: lot.proceeds.toString(),
        realizedPnl: lot.realizedPnl.toString(),
        realizedPnlPercent: lot.realizedPnlPercent.toString(),
        realizedPnlUsd: realizedPnlUsd.toString(), // Store fixed USD value
        buyTradeId: lot.buyTradeId === 'synthetic' ? null : lot.buyTradeId,
        sellTradeId: lot.sellTradeId,
        isPreHistory: lot.isPreHistory,
        costKnown: lot.costKnown,
      };
    });

    // Upsert closed lots (in case we're recalculating)
    // We need to delete existing lots first, then insert new ones
    // For simplicity, we'll delete all existing lots for this wallet/token combination
    if (closedLots.length > 0) {
      const walletId = closedLots[0].walletId;
      const tokenIds = [...new Set(closedLots.map(l => l.tokenId))];

      // Delete existing closed lots for these tokens
      const { error: deleteError } = await supabase
        .from(TABLES.CLOSED_LOT)
        .delete()
        .eq('walletId', walletId)
        .in('tokenId', tokenIds);

      if (deleteError) {
        console.warn('⚠️ Failed to delete existing closed lots:', deleteError.message);
      }
    }

    // Insert new closed lots
    const { error: insertError } = await supabase
      .from(TABLES.CLOSED_LOT)
      .insert(dbLots);

    if (insertError) {
      throw new Error(`Failed to save closed lots: ${insertError.message}`);
    }

    await this.updateTradeFeatureMetrics(closedLots);

    console.log(`✅ Saved ${closedLots.length} closed lots to database`);
  }

  private async updateTradeFeatureMetrics(closedLots: ClosedLot[]) {
    if (!closedLots.length) {
      return;
    }

    const sellAggregates = new Map<string, RealizedAggregate>();
    const buyAggregates = new Map<string, RealizedAggregate>();

    const accumulate = (map: Map<string, RealizedAggregate>, tradeId: string | null, lot: ClosedLot) => {
      if (!tradeId) {
        return;
      }
      const size = lot.size || 0;
      const cost = lot.costBasis || 0;
      const pnl = lot.realizedPnl || 0;
      const holdSeconds = (lot.holdTimeMinutes || 0) * 60;

      const current =
        map.get(tradeId) || { totalPnl: 0, totalCost: 0, totalHoldSeconds: 0, totalSize: 0 };

      current.totalPnl += pnl;
      current.totalCost += cost;
      if (size > 0) {
        current.totalSize += size;
        current.totalHoldSeconds += holdSeconds * size;
      }

      map.set(tradeId, current);
    };

    for (const lot of closedLots) {
      accumulate(sellAggregates, lot.sellTradeId, lot);
      if (lot.buyTradeId && lot.buyTradeId !== 'synthetic') {
        accumulate(buyAggregates, lot.buyTradeId, lot);
      }
    }

    const updates: Array<Promise<void>> = [];

    const queueUpdates = (map: Map<string, RealizedAggregate>) => {
      for (const [tradeId, agg] of map.entries()) {
        const realizedPnlPercent =
          agg.totalCost > 0 ? (agg.totalPnl / agg.totalCost) * 100 : null;
        const holdTimeSeconds =
          agg.totalSize > 0
            ? Math.max(0, Math.round(agg.totalHoldSeconds / agg.totalSize))
            : null;

        updates.push(
          this.tradeFeatureRepo
            .updateRealizedMetrics({
              tradeId,
              realizedPnlUsd: agg.totalPnl,
              realizedPnlPercent,
              holdTimeSeconds,
            })
            .catch(error => {
              console.warn(`⚠️  Failed to update trade feature metrics for trade ${tradeId}:`, error.message || error);
            })
        );
      }
    };

    queueUpdates(sellAggregates);
    queueUpdates(buyAggregates);

    if (updates.length > 0) {
      await Promise.all(updates);
    }
  }

  /**
   * Get closed lots for a wallet (aggregated by token for closed positions)
   */
  async getClosedLotsForWallet(
    walletId: string,
    tokenId?: string
  ): Promise<ClosedLot[]> {
    let query = supabase
      .from(TABLES.CLOSED_LOT)
      .select('*')
      .eq('walletId', walletId)
      .order('exitTime', { ascending: false });

    if (tokenId) {
      query = query.eq('tokenId', tokenId);
    }

    const { data, error } = await query;

    if (error) {
      // If table doesn't exist, return empty array (migration not run yet)
      if (error.message?.includes('does not exist') || error.code === '42P01') {
        console.warn(`⚠️  ClosedLot table does not exist yet. Please run ADD_CLOSED_LOTS.sql migration.`);
        return [];
      }
      throw new Error(`Failed to fetch closed lots: ${error.message}`);
    }

    if (!data) {
      return [];
    }

    // Convert from database format
    return data.map((row: any) => ({
      walletId: row.walletId,
      tokenId: row.tokenId,
      size: Number(row.size),
      entryPrice: Number(row.entryPrice),
      exitPrice: Number(row.exitPrice),
      entryTime: new Date(row.entryTime),
      exitTime: new Date(row.exitTime),
      holdTimeMinutes: row.holdTimeMinutes,
      costBasis: Number(row.costBasis),
      proceeds: Number(row.proceeds),
      realizedPnl: Number(row.realizedPnl),
      realizedPnlPercent: Number(row.realizedPnlPercent),
      buyTradeId: row.buyTradeId,
      sellTradeId: row.sellTradeId,
      isPreHistory: row.isPreHistory,
      costKnown: row.costKnown,
    }));
  }
}

