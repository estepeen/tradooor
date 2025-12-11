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

const STABLE_BASES = new Set(['SOL', 'WSOL', 'USDC', 'USDT']);

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
}

interface OpenPosition {
  walletId: string;
  tokenId: string;
  balance: number; // Current token balance (sum of remaining open lots)
  totalCostBase: number; // Total cost basis in base currency
  averageBuyPrice: number; // Weighted average entry price
  firstBuyTimestamp: Date | null; // When the position was first opened
  lastTradeTimestamp: Date | null; // When the position was last updated
  buyCount: number; // Number of BUY/ADD trades
  sellCount: number; // Number of SELL trades (partial sells)
  removeCount: number; // Number of REM trades
  baseToken: string; // Base token used (SOL, USDC, USDT)
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
   * Also returns open positions (remaining lots)
   * 
   * @param walletId - Wallet ID
   * @param tokenId - Token ID (optional, if not provided, processes all tokens)
   * @param trackingStartTime - When tracking started (for pre-history detection)
   */
  async processTradesForWallet(
    walletId: string,
    tokenId?: string,
    trackingStartTime?: Date
  ): Promise<{ closedLots: ClosedLot[]; openPositions: OpenPosition[] }> {
    // DŮLEŽITÉ: Timeout protection pro načítání trades - prevence zasekávání
    const TRADES_FETCH_TIMEOUT_MS = 60000; // 60 sekund
    
    const fetchTradesPromise = (async () => {
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
      
      return trades;
    })();
    
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Trades fetch timeout')), TRADES_FETCH_TIMEOUT_MS)
    );
    
    let trades;
    try {
      trades = await Promise.race([fetchTradesPromise, timeoutPromise]) as any[];
    } catch (error: any) {
      if (error.message === 'Trades fetch timeout') {
        throw new Error(`Failed to fetch trades: timeout after ${TRADES_FETCH_TIMEOUT_MS}ms. This wallet may have too many trades.`);
      }
      throw error;
    }

    if (!trades || trades.length === 0) {
      return { closedLots: [], openPositions: [] };
    }
    
    console.log(`   📊 Processing ${trades.length} trades for wallet ${walletId.substring(0, 8)}...`);

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
    const allOpenPositions: OpenPosition[] = [];
    const tokensWithoutClosedLots = new Set<string>();

    // Process each token separately
    for (const [tid, tokenTrades] of tradesByToken.entries()) {
      const result = this.processTradesForToken(
        walletId,
        tid,
        tokenTrades,
        trackingStartTime
      );
      if (result.closedLots.length === 0) {
        tokensWithoutClosedLots.add(tid);
      } else {
        allClosedLots.push(...result.closedLots);
      }
      // Add open position if balance > 0
      if (result.openPosition && result.openPosition.balance > 0) {
        allOpenPositions.push(result.openPosition);
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

    return { closedLots: allClosedLots, openPositions: allOpenPositions };
  }

  /**
   * Process trades for a single token using FIFO matching
   * Returns both closed lots and open position (if any)
   */
  private processTradesForToken(
    walletId: string,
    tokenId: string,
    trades: any[],
    trackingStartTime?: Date
  ): { closedLots: ClosedLot[]; openPosition: OpenPosition | null } {
    const openLots: Lot[] = [];
    const closedLots: ClosedLot[] = [];
    let sequenceNumber = 0; // Počítadlo BUY-SELL cyklů pro tento token
    let totalOriginalPosition = 0; // Celková původní pozice (suma všech buy trades)

    // Minimální hodnota v base měně pro považování za reálný trade
    const MIN_BASE_VALUE = 0.0001;

    const normalizeSide = (side: string): 'buy' | 'sell' => {
      const lower = (side || '').toLowerCase();
      if (lower === 'add') return 'buy';
      if (lower === 'remove') return 'sell';
      return lower === 'sell' ? 'sell' : 'buy';
    };

    for (const trade of trades) {
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

        // Čtvrtá fáze: vytvoříme closed lots s sequenceNumber
        for (const data of consumedLotsData) {
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
            sequenceNumber, // Přidáme sequenceNumber
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

    // Create open position from remaining open lots
    let openPosition: OpenPosition | null = null;
    if (openLots.length > 0) {
      const remainingBalance = openLots.reduce((sum, lot) => sum + lot.remainingSize, 0);
      if (remainingBalance > 0) {
        const totalCostBasis = openLots.reduce((sum, lot) => sum + (lot.remainingSize * lot.entryPrice), 0);
        const averageBuyPrice = remainingBalance > 0 ? totalCostBasis / remainingBalance : 0;
        const firstBuyTime = openLots[0]?.entryTime || null;
        const lastTrade = trades.length > 0 ? trades[trades.length - 1] : null;
        const lastTradeTime = lastTrade ? new Date(lastTrade.timestamp) : null;
        
        // Count trade types
        let buyCount = 0;
        let sellCount = 0;
        let removeCount = 0;
        for (const trade of trades) {
          const side = (trade.side || '').toLowerCase();
          if (side === 'buy' || side === 'add') buyCount++;
          else if (side === 'sell') sellCount++;
          else if (side === 'remove') removeCount++;
        }
        
        // Get base token from first trade
        const baseToken = trades.length > 0 
          ? ((trades[0] as any).meta?.baseToken || 'SOL').toUpperCase()
          : 'SOL';
        
        openPosition = {
          walletId,
          tokenId,
          balance: remainingBalance,
          totalCostBase: totalCostBasis,
          averageBuyPrice,
          firstBuyTimestamp: firstBuyTime,
          lastTradeTimestamp: lastTradeTime,
          buyCount,
          sellCount,
          removeCount,
          baseToken,
        };
      }
    }

    return { closedLots, openPosition };
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
    // DŮLEŽITÉ: Validujeme, že trade IDs existují v DB před uložením
    const validTradeIds = new Set<string>();
    if (closedLots.length > 0) {
      // Získej všechny unikátní trade IDs
      const allTradeIds = new Set<string>();
      for (const lot of closedLots) {
        if (lot.buyTradeId && lot.buyTradeId !== 'synthetic') {
          allTradeIds.add(lot.buyTradeId);
        }
        if (lot.sellTradeId && lot.sellTradeId !== 'synthetic') {
          allTradeIds.add(lot.sellTradeId);
        }
      }

      // Ověř, které trade IDs existují v DB
      // Supabase .in() má limit ~1000 items, takže rozdělíme na batchy
      // DŮLEŽITÉ: Přidán timeout protection a lepší error handling pro prevenci zasekávání
      if (allTradeIds.size > 0) {
        const tradeIdsArray = Array.from(allTradeIds);
        const BATCH_SIZE = 500; // Bezpečný limit pro Supabase .in()
        const VALIDATION_TIMEOUT_MS = 30000; // 30 sekund timeout pro celou validaci
        const BATCH_TIMEOUT_MS = 5000; // 5 sekund timeout pro každý batch
        
        const validationStartTime = Date.now();
        let processedBatches = 0;
        
        for (let i = 0; i < tradeIdsArray.length; i += BATCH_SIZE) {
          // Kontrola celkového timeoutu
          if (Date.now() - validationStartTime > VALIDATION_TIMEOUT_MS) {
            console.warn(`⚠️  Trade ID validation timeout after ${VALIDATION_TIMEOUT_MS}ms. Processed ${processedBatches} batches, skipping remaining ${Math.ceil((tradeIdsArray.length - i) / BATCH_SIZE)} batches.`);
            break;
          }
          
          const batch = tradeIdsArray.slice(i, i + BATCH_SIZE);
          
          try {
            // Timeout protection pro každý batch
            const batchPromise = supabase
              .from(TABLES.TRADE)
              .select('id')
              .in('id', batch);
            
            const timeoutPromise = new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Batch timeout')), BATCH_TIMEOUT_MS)
            );
            
            const { data: existingTrades, error: checkError } = await Promise.race([
              batchPromise,
              timeoutPromise
            ]) as any;
            
            if (checkError) {
              console.warn(`⚠️  Error checking trade IDs existence (batch ${processedBatches + 1}): ${checkError.message}`);
              // Pokud selže kontrola, nastavíme všechny na null (bezpečnější než crash)
              continue;
            }
            
            if (existingTrades) {
              for (const trade of existingTrades) {
                if (trade.id) {
                  validTradeIds.add(trade.id);
                }
              }
            }
            
            processedBatches++;
          } catch (error: any) {
            if (error.message === 'Batch timeout') {
              console.warn(`⚠️  Batch ${processedBatches + 1} timed out after ${BATCH_TIMEOUT_MS}ms. Skipping this batch.`);
              continue;
            }
            console.warn(`⚠️  Unexpected error validating trade IDs (batch ${processedBatches + 1}):`, error?.message || error);
            continue;
          }
        }
        
        console.log(`   ✅ Validated ${validTradeIds.size}/${allTradeIds.size} trade IDs exist in DB (processed ${processedBatches} batches)`);
      }
    }

    const dbLots = closedLots.map(lot => {
      // Validuj buyTradeId - pokud neexistuje, nastav na null
      let buyTradeId: string | null = null;
      if (lot.buyTradeId && lot.buyTradeId !== 'synthetic' && typeof lot.buyTradeId === 'string') {
        if (validTradeIds.has(lot.buyTradeId)) {
          buyTradeId = lot.buyTradeId;
        } else {
          console.warn(`⚠️  buyTradeId ${lot.buyTradeId} does not exist in DB, setting to null`);
          buyTradeId = null;
        }
      }

      // Validuj sellTradeId - pokud neexistuje, nastav na null
      let sellTradeId: string | null = null;
      if (lot.sellTradeId && lot.sellTradeId !== 'synthetic' && typeof lot.sellTradeId === 'string') {
        if (validTradeIds.has(lot.sellTradeId)) {
          sellTradeId = lot.sellTradeId;
        } else {
          console.warn(`⚠️  sellTradeId ${lot.sellTradeId} does not exist in DB, setting to null`);
          sellTradeId = null;
        }
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
        realizedPnl: lot.realizedPnl.toString(), // PnL v SOL/base měně (primární hodnota)
        realizedPnlPercent: lot.realizedPnlPercent.toString(),
        realizedPnlUsd: null, // Nepoužíváme USD, PnL je v SOL (zůstává v DB pro zpětnou kompatibilitu)
        buyTradeId,
        sellTradeId,
        isPreHistory: lot.isPreHistory,
        costKnown: lot.costKnown,
        sequenceNumber: lot.sequenceNumber ?? null, // Kolikátý BUY-SELL cyklus (1., 2., 3. atd.)
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

  /**
   * Save open positions to database
   */
  async saveOpenPositions(openPositions: OpenPosition[]): Promise<void> {
    if (openPositions.length === 0) {
      // If no open positions, delete all existing ones for this wallet
      if (openPositions.length === 0) {
        // This will be handled by the caller with walletId
        return;
      }
    }

    // Convert to database format
    const dbPositions = openPositions.map(pos => {
      return {
        walletId: pos.walletId,
        tokenId: pos.tokenId,
        balance: pos.balance.toString(),
        totalCostBase: pos.totalCostBase.toString(),
        averageBuyPrice: pos.averageBuyPrice.toString(),
        firstBuyTimestamp: pos.firstBuyTimestamp?.toISOString() || null,
        lastTradeTimestamp: pos.lastTradeTimestamp?.toISOString() || null,
        buyCount: pos.buyCount,
        sellCount: pos.sellCount,
        removeCount: pos.removeCount,
        baseToken: pos.baseToken,
      };
    });

    // Upsert open positions (update if exists, insert if not)
    // First, delete all existing open positions for wallets/tokens we're updating
    if (openPositions.length > 0) {
      const walletId = openPositions[0].walletId;
      const tokenIds = [...new Set(openPositions.map(p => p.tokenId))];

      // Delete existing open positions for these tokens
      const { error: deleteError } = await supabase
        .from('OpenPosition')
        .delete()
        .eq('walletId', walletId)
        .in('tokenId', tokenIds);

      if (deleteError) {
        console.warn('⚠️ Failed to delete existing open positions:', deleteError.message);
      }
    }

    // Insert new open positions
    if (dbPositions.length > 0) {
      const { error: insertError } = await supabase
        .from('OpenPosition')
        .insert(dbPositions);

      if (insertError) {
        throw new Error(`Failed to save open positions: ${insertError.message}`);
      }

      console.log(`✅ Saved ${openPositions.length} open positions to database`);
    }
  }

  /**
   * Delete all open positions for a wallet (when all positions are closed)
   */
  async deleteOpenPositionsForWallet(walletId: string, tokenIds?: string[]): Promise<void> {
    let query = supabase
      .from('OpenPosition')
      .delete()
      .eq('walletId', walletId);

    if (tokenIds && tokenIds.length > 0) {
      query = query.in('tokenId', tokenIds);
    }

    const { error } = await query;

    if (error) {
      console.warn(`⚠️ Failed to delete open positions for wallet ${walletId}:`, error.message);
    } else {
      console.log(`✅ Deleted open positions for wallet ${walletId}`);
    }
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

