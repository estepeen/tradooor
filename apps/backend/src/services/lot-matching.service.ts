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
import { TokenMarketDataService } from './token-market-data.service.js';
import { TokenRepository } from '../repositories/token.repository.js';

const STABLE_BASES = new Set(['SOL', 'WSOL', 'USDC', 'USDT']);

/**
 * Helper functions for calculating timing and market condition metrics
 */
function getHourOfDay(date: Date): number {
  return date.getUTCHours();
}

function getDayOfWeek(date: Date): number {
  return date.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
}

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
  // realizedPnl je v SOL/base měně (primární hodnota)
  buyTradeId: string;
  sellTradeId: string;
  isPreHistory: boolean;
  costKnown: boolean;
  sequenceNumber?: number; // Kolikátý BUY-SELL cyklus pro tento token (1., 2., 3. atd.)
  
  // Entry/Exit Timing Metrics
  entryHourOfDay?: number; // Hour of day (0-23) when entry occurred
  entryDayOfWeek?: number; // Day of week (0=Sunday, 1=Monday, ..., 6=Saturday)
  exitHourOfDay?: number; // Hour of day (0-23) when exit occurred
  exitDayOfWeek?: number; // Day of week (0=Sunday, 1=Monday, ..., 6=Saturday)
  
  // Market Conditions at Entry/Exit
  entryMarketCap?: number | null; // Market cap at entry (USD)
  exitMarketCap?: number | null; // Market cap at exit (USD)
  entryLiquidity?: number | null; // Liquidity at entry (USD)
  exitLiquidity?: number | null; // Liquidity at exit (USD)
  entryVolume24h?: number | null; // 24h volume at entry (USD)
  exitVolume24h?: number | null; // 24h volume at exit (USD)
  tokenAgeAtEntryMinutes?: number | null; // Token age in minutes at entry
  
  // Stop-Loss/Take-Profit Detection
  exitReason?: 'take_profit' | 'stop_loss' | 'manual' | 'unknown' | null;
  maxProfitPercent?: number | null; // Maximum profit % during hold period
  maxDrawdownPercent?: number | null; // Maximum drawdown % during hold period
  timeToMaxProfitMinutes?: number | null; // Time to reach max profit (minutes from entry)
  
  // DCA Tracking
  dcaEntryCount?: number | null; // Number of BUY trades that form this closed lot
  dcaTimeSpanMinutes?: number | null; // Time span from first BUY to last BUY before SELL
  
  // Re-entry Patterns
  reentryTimeMinutes?: number | null; // Time from previous exit to this entry (null for first cycle)
  reentryPriceChangePercent?: number | null; // Price change % from previous exit
  previousCyclePnl?: number | null; // PnL of previous cycle (for comparison)
}

type RealizedAggregate = {
  totalPnl: number;
  totalCost: number;
  totalHoldSeconds: number;
  totalSize: number;
};

export class LotMatchingService {
  private tradeFeatureRepo: TradeFeatureRepository;
  private marketDataService: TokenMarketDataService;
  private tokenRepo: TokenRepository;

  constructor(
    tradeFeatureRepo: TradeFeatureRepository = new TradeFeatureRepository(),
    tokenRepo: TokenRepository = new TokenRepository()
  ) {
    this.tradeFeatureRepo = tradeFeatureRepo;
    this.marketDataService = new TokenMarketDataService();
    this.tokenRepo = tokenRepo;
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
    const tokensWithoutClosedLots = new Set<string>();

    // Process each token separately
    for (const [tid, tokenTrades] of tradesByToken.entries()) {
      const closedLots = await this.processTradesForToken(
        walletId,
        tid,
        tokenTrades,
        trackingStartTime
      );
      if (closedLots.length === 0) {
        tokensWithoutClosedLots.add(tid);
      } else {
      allClosedLots.push(...closedLots);
      }
    }

    if (tokensWithoutClosedLots.size > 0) {
      const { error } = await supabase
        .from(TABLES.CLOSED_LOT)
        .delete()
        .eq('walletId', walletId)
        .in('tokenId', Array.from(tokensWithoutClosedLots));

      if (error) {
        console.warn(
          `⚠️  Failed to delete closed lots for tokens without stable valuations: ${error.message}`
        );
      }
    }

    return allClosedLots;
  }

  /**
   * Process trades for a single token using FIFO matching
   */
  private async processTradesForToken(
    walletId: string,
    tokenId: string,
    trades: any[],
    trackingStartTime?: Date
  ): Promise<ClosedLot[]> {
    const openLots: Lot[] = [];
    const closedLots: ClosedLot[] = [];
    let sequenceNumber = 0; // Počítadlo BUY-SELL cyklů pro tento token
    let totalOriginalPosition = 0; // Celková původní pozice (suma všech buy trades)
    
    // Track previous cycle data for re-entry patterns
    const previousCycles = new Map<number, { exitTime: Date; exitPrice: number; pnl: number }>();
    
    // Get token mint address for market data fetching
    // We'll fetch it from database or get it from trades
    let mintAddress: string | undefined;
    const firstTrade = trades.find(t => t.tokenId === tokenId);
    if (firstTrade) {
      const token = (firstTrade as any).Token || (firstTrade as any).token;
      mintAddress = token?.mintAddress;
    }
    
    // If not found in trade, try to fetch from database
    if (!mintAddress) {
      const { data: tokenData } = await supabase
        .from(TABLES.TOKEN)
        .select('mintAddress')
        .eq('id', tokenId)
        .single();
      mintAddress = tokenData?.mintAddress;
    }

    // Minimální hodnota v base měně pro považování za reálný trade
    const MIN_BASE_VALUE = 0.0001;

    const normalizeSide = (side: string): 'buy' | 'sell' => {
      const lower = (side || '').toLowerCase();
      if (lower === 'add') return 'buy';
      if (lower === 'remove') return 'sell';
      return lower === 'sell' ? 'sell' : 'buy';
    };

    // DŮLEŽITÉ: Seřaď trades podle timestampu (ascending) - zajišťuje správné FIFO párování
    // Pokud SELL přijde před BUY (kvůli pořadí v databázi), může to způsobit problém
    const sortedTrades = [...trades].sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime();
      const timeB = new Date(b.timestamp).getTime();
      if (timeA !== timeB) {
        return timeA - timeB;
      }
      // Pokud mají stejný timestamp, BUY má přednost před SELL (pro správné párování)
      const sideA = normalizeSide(a.side);
      const sideB = normalizeSide(b.side);
      if (sideA === 'buy' && sideB === 'sell') return -1;
      if (sideA === 'sell' && sideB === 'buy') return 1;
      return 0;
    });

    for (const trade of sortedTrades) {
      // DŮLEŽITÉ: Vyloučit void trades (token-to-token swapy, ADD/REMOVE LIQUIDITY) z closed lots
      const tradeSide = (trade.side || '').toLowerCase();
      if (tradeSide === 'void') {
        continue; // Přeskoč void trades - nepočítají se do closed lots
      }

      const baseToken = ((trade as any).meta?.baseToken || 'SOL').toUpperCase();
      if (!STABLE_BASES.has(baseToken)) {
        continue;
      }

      const side = normalizeSide(trade.side);
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

      // DŮLEŽITÉ: Closed position = BUY (počátek) + SELL (konec, balance = 0)
      // ADD a REM jsou jen mezistupně - REM neuzavírá pozici, pouze SELL
      if (side === 'buy') {
        // BUY/ADD: Add new lot (oba přidávají do open lots)
        openLots.push({
          remainingSize: amount,
          entryPrice: price,
          entryTime: timestamp,
          tradeId: trade.id,
          isSynthetic: false,
          costKnown: true,
        });
        // Sleduj celkovou původní pozici (pro dust threshold)
        totalOriginalPosition += amount;
      } else if (side === 'sell') {
        // SELL: Match against open lots using FIFO a vytvoř closed lot
        // SELL je finální prodej, který uzavírá pozici (balance = 0)
        let toSell = amount;
        const openLotsBeforeSell = openLots.length; // Počet open lots před SELL
        
        // DŮLEŽITÉ: Použij skutečnou hodnotu SELL trade (valueUsd nebo amountBase) místo price * amount
        // Tím zajistíme, že proceeds odpovídají skutečné hodnotě z VALUE sloupce
        const sellTradeValue = Number(trade.valueUsd || trade.amountBase || 0);
        
        // Uložíme si data o spotřebovaných lots před jejich spotřebou
        const consumedLotsData: Array<{
          lot: Lot;
          consumed: number;
          costBasis: number;
          proceeds: number;
          realizedPnl: number;
          realizedPnlPercent: number;
          holdTimeMinutes: number;
        }> = [];

        // První fáze: spočítáme celkové množství tokenů spotřebovaných z open lots
        let totalConsumedFromOpenLots = 0;
        let tempToSellForCount = toSell;
        const tempOpenLotsForCount = openLots.map(lot => ({ ...lot }));
        while (tempToSellForCount > 0 && tempOpenLotsForCount.length > 0) {
          const lot = tempOpenLotsForCount[0];
          const consumed = Math.min(tempToSellForCount, lot.remainingSize);
          totalConsumedFromOpenLots += consumed;
          lot.remainingSize -= consumed;
          if (lot.remainingSize <= 0.00000001) {
            tempOpenLotsForCount.shift();
          }
          tempToSellForCount -= consumed;
        }

        // Druhá fáze: vypočítáme data o spotřebovaných lots (bez jejich spotřeby)
        let tempToSell = toSell;
        const tempOpenLots = openLots.map(lot => ({ ...lot })); // Kopie pro simulaci
        
        while (tempToSell > 0 && tempOpenLots.length > 0) {
          const lot = tempOpenLots[0];
          const consumed = Math.min(tempToSell, lot.remainingSize);

          const costBasis = consumed * lot.entryPrice;
          // DŮLEŽITÉ: Proceeds = proporční část skutečné hodnoty SELL trade
          // Použijeme skutečnou hodnotu SELL trade (valueUsd) a rozdělíme ji podle množství tokenů
          const proceeds = sellTradeValue > 0 && totalConsumedFromOpenLots > 0
            ? (consumed / totalConsumedFromOpenLots) * sellTradeValue
            : consumed * price; // Fallback na starý výpočet, pokud nemáme value nebo totalConsumed = 0
          const realizedPnl = proceeds - costBasis;
          const realizedPnlPercent = lot.costKnown && costBasis > 0
            ? (realizedPnl / costBasis) * 100
            : 0;

          const holdTimeMinutes = Math.round(
            (timestamp.getTime() - lot.entryTime.getTime()) / (1000 * 60)
          );

          consumedLotsData.push({
            lot: { ...lot }, // Kopie lotu
            consumed,
            costBasis,
            proceeds,
            realizedPnl,
            realizedPnlPercent,
            holdTimeMinutes,
          });

          // Simulace spotřeby (na kopii)
          lot.remainingSize -= consumed;
          if (lot.remainingSize <= 0.00000001) {
            tempOpenLots.shift();
          }

          tempToSell -= consumed;
        }

        // Druhá fáze: skutečně spotřebujeme lots
        while (toSell > 0 && openLots.length > 0) {
          const lot = openLots[0];
          const consumed = Math.min(toSell, lot.remainingSize);

          lot.remainingSize -= consumed;
          if (lot.remainingSize <= 0.00000001) {
            openLots.shift();
          }

          toSell -= consumed;
        }

        // Třetí fáze: zjistíme, jestli pozice byla uzavřena a určíme sequenceNumber
        const openLotsAfterSell = openLots.length;
        const positionClosed = openLotsAfterSell === 0 && openLotsBeforeSell > 0;
        
        // Pokud pozice byla uzavřena, zvýšíme sequenceNumber pro další cyklus
        if (positionClosed) {
          sequenceNumber++;
        }
        
        // Pokud je sequenceNumber 0 (první cyklus ještě nezačal), nastavíme ho na 1
        if (sequenceNumber === 0) {
          sequenceNumber = 1;
        }

        // Čtvrtá fáze: vytvoříme closed lots s sequenceNumber a novými metrikami
        // Calculate DCA metrics (count of BUY trades that form this closed lot)
        const dcaEntryCount = consumedLotsData.length; // Number of different BUY trades
        const firstEntryTime = consumedLotsData.length > 0 
          ? consumedLotsData.reduce((min, d) => d.lot.entryTime < min ? d.lot.entryTime : min, consumedLotsData[0].lot.entryTime)
          : timestamp;
        const lastEntryTime = consumedLotsData.length > 0
          ? consumedLotsData.reduce((max, d) => d.lot.entryTime > max ? d.lot.entryTime : max, consumedLotsData[0].lot.entryTime)
          : timestamp;
        const dcaTimeSpanMinutes = Math.round((lastEntryTime.getTime() - firstEntryTime.getTime()) / (1000 * 60));
        
        // Get previous cycle data for re-entry patterns
        const previousCycle = previousCycles.get(sequenceNumber - 1);
        const reentryTimeMinutes = previousCycle 
          ? Math.round((firstEntryTime.getTime() - previousCycle.exitTime.getTime()) / (1000 * 60))
          : null;
        const reentryPriceChangePercent = previousCycle && previousCycle.exitPrice > 0
          ? ((price - previousCycle.exitPrice) / previousCycle.exitPrice) * 100
          : null;
        const previousCyclePnl = previousCycle ? previousCycle.pnl : null;
        
        // Fetch market data (entry and exit) - fetch once for all lots in this SELL
        // Note: This might be slow, so we'll do it in background or cache it
        // For now, we'll skip market data fetching to avoid slowing down the process
        // TODO: Fetch market data in background job or batch process
        let entryMarketData: any = null;
        let exitMarketData: any = null;
        
        // Skip market data fetching for now (can be added later in background job)
        // if (mintAddress) {
        //   try {
        //     entryMarketData = await this.marketDataService.getMarketData(mintAddress, firstEntryTime);
        //     exitMarketData = await this.marketDataService.getMarketData(mintAddress, timestamp);
        //   } catch (error: any) {
        //     console.warn(`⚠️  Failed to fetch market data for token ${tokenId}: ${error.message}`);
        //   }
        // }
        
        for (const data of consumedLotsData) {
          // Calculate timing metrics
          const entryHour = getHourOfDay(data.lot.entryTime);
          const entryDay = getDayOfWeek(data.lot.entryTime);
          const exitHour = getHourOfDay(timestamp);
          const exitDay = getDayOfWeek(timestamp);
          
          // Calculate max profit/drawdown (simplified - would need price history for accurate calculation)
          // For now, we'll use entry/exit price as approximation
          const maxProfitPercent = data.realizedPnlPercent > 0 ? data.realizedPnlPercent : null;
          const maxDrawdownPercent = data.realizedPnlPercent < 0 ? Math.abs(data.realizedPnlPercent) : null;
          
          // Detect exit reason (simplified - would need price history for accurate detection)
          let exitReason: 'take_profit' | 'stop_loss' | 'manual' | 'unknown' = 'unknown';
          if (data.realizedPnlPercent > 10) {
            exitReason = 'take_profit'; // Likely take-profit if profit > 10%
          } else if (data.realizedPnlPercent < -10) {
            exitReason = 'stop_loss'; // Likely stop-loss if loss > 10%
          } else {
            exitReason = 'manual'; // Manual exit otherwise
          }
          
          closedLots.push({
            walletId,
            tokenId,
            size: data.consumed,
            entryPrice: data.lot.entryPrice,
            exitPrice: price,
            entryTime: data.lot.entryTime,
            exitTime: timestamp,
            holdTimeMinutes: data.holdTimeMinutes,
            costBasis: data.costBasis,
            proceeds: data.proceeds,
            realizedPnl: data.realizedPnl,
            realizedPnlPercent: data.realizedPnlPercent,
            buyTradeId: data.lot.tradeId,
            sellTradeId: trade.id,
            isPreHistory: data.lot.isSynthetic || false,
            costKnown: data.lot.costKnown !== false,
            sequenceNumber,
            
            // Entry/Exit Timing Metrics
            entryHourOfDay: entryHour,
            entryDayOfWeek: entryDay,
            exitHourOfDay: exitHour,
            exitDayOfWeek: exitDay,
            
            // Market Conditions at Entry/Exit
            entryMarketCap: entryMarketData?.marketCap ?? null,
            exitMarketCap: exitMarketData?.marketCap ?? null,
            entryLiquidity: entryMarketData?.liquidity ?? null,
            exitLiquidity: exitMarketData?.liquidity ?? null,
            entryVolume24h: entryMarketData?.volume24h ?? null,
            exitVolume24h: exitMarketData?.volume24h ?? null,
            tokenAgeAtEntryMinutes: entryMarketData?.tokenAgeMinutes ?? null,
            
            // Stop-Loss/Take-Profit Detection
            exitReason,
            maxProfitPercent,
            maxDrawdownPercent,
            timeToMaxProfitMinutes: null, // TODO: Would need price history to calculate accurately
            
            // DCA Tracking
            dcaEntryCount: dcaEntryCount > 1 ? dcaEntryCount : null, // Only set if multiple BUY trades
            dcaTimeSpanMinutes: dcaTimeSpanMinutes > 0 ? dcaTimeSpanMinutes : null,
            
            // Re-entry Patterns
            reentryTimeMinutes,
            reentryPriceChangePercent,
            previousCyclePnl,
          });
        }
        
        // Store cycle data for next cycle
        if (positionClosed && consumedLotsData.length > 0) {
          const totalPnl = consumedLotsData.reduce((sum, d) => sum + d.realizedPnl, 0);
          previousCycles.set(sequenceNumber, {
            exitTime: timestamp,
            exitPrice: price,
            pnl: totalPnl,
          });
        }

        // If we still have tokens to sell but no open lots, this is a SELL without BUY (pre-history)
        // DŮLEŽITÉ: NEPŘIDÁVÁME synthetic lots do closedLots, protože:
        // 1. Neznáme cost basis (PnL = 0, nemá smysl zobrazovat)
        // 2. Nevíme, kdy byl skutečný buy (hold time je nepřesný)
        // 3. Closed positions by měly obsahovat jen kompletní trades (BUY/ADD + SELL)
        if (toSell > 0) {
          console.log(`   ⚠️  SELL without matching BUY/ADD for token ${tokenId}: ${toSell} tokens sold at ${price} - skipping (pre-history, no cost basis)`);
          // Nepřidáváme do closedLots - není to kompletní trade
        }
      }
    }

    // NOVÉ: Po zpracování všech trades zkontroluj zbývající open lots
    // Pokud je balance < 2% původní pozice, vytvoř synthetic closed lot (dust position)
    if (openLots.length > 0 && totalOriginalPosition > 0) {
      // Vypočítej zbývající balance (suma zbývajících open lots)
      const remainingBalance = openLots.reduce((sum, lot) => sum + lot.remainingSize, 0);
      
      // Threshold: 2% původní pozice
      const DUST_THRESHOLD_PERCENT = 0.02; // 2%
      const balancePercent = remainingBalance / totalOriginalPosition;
      const isDust = remainingBalance > 0 && balancePercent < DUST_THRESHOLD_PERCENT;
      
      if (isDust) {
        // Získej aktuální cenu tokenu (z posledního trade nebo použij průměrnou entry price jako fallback)
        const lastTrade = trades.length > 0 ? trades[trades.length - 1] : null;
        let exitPrice = 0;
        
        if (lastTrade) {
          const lastTradePrice = Number(lastTrade.priceBasePerToken || 0);
          if (lastTradePrice > 0) {
            exitPrice = lastTradePrice;
          }
        }
        
        // Pokud nemáme aktuální cenu z posledního trade, použij průměrnou entry price (unrealized PnL = 0)
        if (exitPrice <= 0) {
          const totalCostBasis = openLots.reduce((sum, lot) => sum + (lot.remainingSize * lot.entryPrice), 0);
          exitPrice = remainingBalance > 0 ? totalCostBasis / remainingBalance : 0;
        }
        
        // Vytvoř synthetic closed lot pro zbývající balance
        const totalCostBasis = openLots.reduce((sum, lot) => sum + (lot.remainingSize * lot.entryPrice), 0);
        const totalProceeds = remainingBalance * exitPrice;
        const realizedPnl = totalProceeds - totalCostBasis;
        const realizedPnlPercent = totalCostBasis > 0 ? (realizedPnl / totalCostBasis) * 100 : 0;
        
        // Použij čas prvního buy jako entry time
        const entryTime = openLots[0].entryTime;
        const exitTime = new Date(); // Aktuální čas
        const holdTimeMinutes = Math.round((exitTime.getTime() - entryTime.getTime()) / (1000 * 60));
        
        // Zvýš sequenceNumber pro synthetic closed lot
        sequenceNumber++;
        if (sequenceNumber === 0) {
          sequenceNumber = 1;
        }
        
        closedLots.push({
          walletId,
          tokenId,
          size: remainingBalance,
          entryPrice: totalCostBasis / remainingBalance, // Průměrná entry price
          exitPrice,
          entryTime,
          exitTime,
          holdTimeMinutes,
          costBasis: totalCostBasis,
          proceeds: totalProceeds,
          realizedPnl,
          realizedPnlPercent,
          buyTradeId: 'synthetic', // Označ jako synthetic
          sellTradeId: 'synthetic', // Označ jako synthetic
          isPreHistory: false, // Není pre-history, je to dust
          costKnown: true,
          sequenceNumber,
        });
        
        console.log(`   🧹 [Dust] Created synthetic closed lot for token ${tokenId}: ${remainingBalance.toFixed(6)} tokens (${(balancePercent * 100).toFixed(2)}% of original position)`);
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

    // Convert to database format
    // DŮLEŽITÉ: PnL je nyní v SOL/base měně, ne v USD
    const dbLots = closedLots.map(lot => {
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
        realizedPnl: lot.realizedPnl.toString(), // PnL v SOL/base měně (primární hodnota)
        realizedPnlPercent: lot.realizedPnlPercent.toString(),
        realizedPnlUsd: null, // Nepoužíváme USD, PnL je v SOL (zůstává v DB pro zpětnou kompatibilitu)
        buyTradeId: lot.buyTradeId === 'synthetic' ? null : lot.buyTradeId,
        sellTradeId: lot.sellTradeId,
        isPreHistory: lot.isPreHistory,
        costKnown: lot.costKnown,
        sequenceNumber: lot.sequenceNumber ?? null, // Kolikátý BUY-SELL cyklus (1., 2., 3. atd.)
        
        // Entry/Exit Timing Metrics
        entryHourOfDay: lot.entryHourOfDay ?? null,
        entryDayOfWeek: lot.entryDayOfWeek ?? null,
        exitHourOfDay: lot.exitHourOfDay ?? null,
        exitDayOfWeek: lot.exitDayOfWeek ?? null,
        
        // Market Conditions at Entry/Exit
        entryMarketCap: lot.entryMarketCap !== null && lot.entryMarketCap !== undefined ? lot.entryMarketCap.toString() : null,
        exitMarketCap: lot.exitMarketCap !== null && lot.exitMarketCap !== undefined ? lot.exitMarketCap.toString() : null,
        entryLiquidity: lot.entryLiquidity !== null && lot.entryLiquidity !== undefined ? lot.entryLiquidity.toString() : null,
        exitLiquidity: lot.exitLiquidity !== null && lot.exitLiquidity !== undefined ? lot.exitLiquidity.toString() : null,
        entryVolume24h: lot.entryVolume24h !== null && lot.entryVolume24h !== undefined ? lot.entryVolume24h.toString() : null,
        exitVolume24h: lot.exitVolume24h !== null && lot.exitVolume24h !== undefined ? lot.exitVolume24h.toString() : null,
        tokenAgeAtEntryMinutes: lot.tokenAgeAtEntryMinutes ?? null,
        
        // Stop-Loss/Take-Profit Detection
        exitReason: lot.exitReason ?? null,
        maxProfitPercent: lot.maxProfitPercent !== null && lot.maxProfitPercent !== undefined ? lot.maxProfitPercent.toString() : null,
        maxDrawdownPercent: lot.maxDrawdownPercent !== null && lot.maxDrawdownPercent !== undefined ? lot.maxDrawdownPercent.toString() : null,
        timeToMaxProfitMinutes: lot.timeToMaxProfitMinutes ?? null,
        
        // DCA Tracking
        dcaEntryCount: lot.dcaEntryCount ?? null,
        dcaTimeSpanMinutes: lot.dcaTimeSpanMinutes ?? null,
        
        // Re-entry Patterns
        reentryTimeMinutes: lot.reentryTimeMinutes ?? null,
        reentryPriceChangePercent: lot.reentryPriceChangePercent !== null && lot.reentryPriceChangePercent !== undefined ? lot.reentryPriceChangePercent.toString() : null,
        previousCyclePnl: lot.previousCyclePnl !== null && lot.previousCyclePnl !== undefined ? lot.previousCyclePnl.toString() : null,
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

    // Invalidate portfolio cache for affected wallets
    if (closedLots.length > 0) {
      const walletIds = [...new Set(closedLots.map(l => l.walletId))];
      for (const walletId of walletIds) {
        // Delete portfolio cache to force refresh on next request
        // Note: PortfolioBaseline table name (not in TABLES constant)
        const { error: deleteError } = await supabase
          .from('PortfolioBaseline')
          .delete()
          .eq('walletId', walletId);
        
        if (deleteError) {
          console.warn(`⚠️  Failed to invalidate portfolio cache for wallet ${walletId}:`, deleteError.message);
        } else {
          console.log(`   🗑️  Invalidated portfolio cache for wallet ${walletId}`);
        }
      }
    }

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

