import { Router } from 'express';
import { TradeRepository } from '../repositories/trade.repository.js';
import { SolPriceService } from '../services/sol-price.service.js';
import { TokenPriceService } from '../services/token-price.service.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';
import { supabase, TABLES } from '../lib/supabase.js';
// TokenMetadataBatchService removed - metadata se načítá pouze při webhooku, ne při každém requestu
import { SolscanClient } from '../services/solscan-client.service.js';
import { BinancePriceService } from '../services/binance-price.service.js';

const router = Router();
const tradeRepo = new TradeRepository();
const solPriceService = new SolPriceService();
const tokenPriceService = new TokenPriceService();
const smartWalletRepo = new SmartWalletRepository();
const tokenRepo = new TokenRepository();
const metricsHistoryRepo = new MetricsHistoryRepository();
const metricsCalculator = new MetricsCalculatorService(
  smartWalletRepo,
  tradeRepo,
  metricsHistoryRepo
);
// TokenMetadataBatchService removed - metadata se načítá pouze při webhooku
const solscanClient = new SolscanClient();
const binancePriceService = new BinancePriceService();

// GET /api/trades?walletId=xxx - Get trades for a wallet
router.get('/', async (req, res) => {
  try {
    const walletId = req.query.walletId as string;
    if (!walletId) {
      return res.status(400).json({ error: 'walletId query parameter is required' });
    }

    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 50;
    const tokenId = req.query.tokenId as string | undefined;
    const fromDate = req.query.fromDate ? new Date(req.query.fromDate as string) : undefined;
    const toDate = req.query.toDate ? new Date(req.query.toDate as string) : undefined;
    const forceRecalculate = req.query.forceRecalculate === 'true'; // Vynutit přepočet i když valueUsd existuje

    const result = await tradeRepo.findByWalletId(walletId, {
      page,
      pageSize,
      tokenId,
      fromDate,
      toDate,
    });

    // NOVÝ PŘÍSTUP: Použij base měnu (SOL/USDC/USDT) místo USD
    // - entryPrice = priceBasePerToken (cena v base měně za 1 token)
    // - entryCost = amountBase (pro BUY) / proceedsBase = amountBase (pro SELL)
    // - Realized PnL = proceedsBase - costBase (v base měně)
    // - USD konverze: priceUsd = priceBasePerToken * solPriceUsd (z Binance API)
    const toNumber = (value: any) =>
      value === null || value === undefined ? null : Number(value);
    
    // Vypočítej USD ceny pomocí Binance API (historická cena SOL/USDT)
    const tradesWithBaseCurrency = await Promise.all(
      result.trades.map(async (t: any) => {
        const token = t.Token || t.token;
        const amountToken = Number(t.amountToken);
        const amountBase = Number(t.amountBase);
        const priceBasePerToken = Number(t.priceBasePerToken);
        
        // Urči base token (SOL, USDC, USDT) z meta nebo použij default
        const meta = t.meta as any;
        const baseToken = meta?.baseToken || 'SOL'; // Čti z meta, default SOL
        const source = meta?.source || '';
        const valuationSource = meta?.valuationSource; // 'binance' | 'birdeye' | 'stable'
        
        let priceUsd: number | null = null;
        const existingValueUsd = toNumber(t.valueUsd);
        let computedValueUsd: number | null = existingValueUsd;

        // DŮLEŽITÉ: Pokud má trade valuationSource, pak amountBase a priceBasePerToken jsou už v USD!
        // NormalizedTradeProcessor ukládá: amountBase = valuation.amountBaseUsd, priceBasePerToken = valuation.priceUsdPerToken
        if (valuationSource) {
          // Trade už byl zpracován valuation service → amountBase a priceBasePerToken jsou v USD
          priceUsd = priceBasePerToken > 0 ? priceBasePerToken : null;
          computedValueUsd = existingValueUsd !== null ? existingValueUsd : amountBase;
        } else if (source === 'quicknode-webhook') {
          // QuickNode webhook bez valuation → může být v base měně, použij valueUsd pokud existuje
          priceUsd = priceBasePerToken > 0 ? priceBasePerToken : null;
          computedValueUsd = existingValueUsd !== null ? existingValueUsd : amountBase;
        } else if (baseToken === 'SOL' && priceBasePerToken > 0) {
          // Staré trades bez valuation → přepočítej z SOL na USD
          try {
            const tradeTimestamp = new Date(t.timestamp);
            const solPriceUsd = await binancePriceService.getSolPriceAtTimestamp(tradeTimestamp);
            priceUsd = priceBasePerToken * solPriceUsd;
            if (computedValueUsd === null && priceUsd !== null && amountToken > 0) {
              computedValueUsd = priceUsd * amountToken;
            }
          } catch (error: any) {
            console.warn(`Failed to fetch SOL price from Binance for trade ${t.txSignature}: ${error.message}`);
              priceUsd = null;
          }
        } else if (baseToken === 'USDC' || baseToken === 'USDT') {
          // Stablecoins → 1:1 USD
          priceUsd = priceBasePerToken;
          if (computedValueUsd === null && priceUsd !== null && amountToken > 0) {
            computedValueUsd = priceUsd * amountToken;
          }
        } else {
          // Neznámý base token → použij priceBasePerToken jako USD (pokud existuje)
          priceUsd = priceBasePerToken > 0 ? priceBasePerToken : null;
          if (computedValueUsd === null && priceUsd !== null && amountToken > 0) {
            computedValueUsd = priceUsd * amountToken;
          }
        }
        
        // Fallback: pokud stále nemáme valueUsd, použij amountBase (může být už v USD nebo v base měně)
        if (computedValueUsd === null || computedValueUsd === undefined) {
          computedValueUsd = amountBase;
        }

        // DŮLEŽITÉ: Explicitně přepiš amountBase, amountToken, priceBasePerToken jako čísla
        // aby se předešlo problémům s Prisma Decimal serializací
        const { amountBase: _, amountToken: __, priceBasePerToken: ___, ...rest } = t;
        return {
          ...rest,
          token,
          amountToken, // Explicitně jako number
          amountBase, // Explicitně jako number
          priceBasePerToken, // Explicitně jako number
          // entryPrice = priceBasePerToken (cena v base měně za 1 token)
          entryPrice: priceBasePerToken,
          // entryCost (pro BUY) nebo proceedsBase (pro SELL) = amountBase
          entryCost: t.side === 'buy' ? amountBase : null,
          proceedsBase: t.side === 'sell' ? amountBase : null,
          baseToken, // SOL, USDC, USDT
          // USD cena tokenu (vypočítaná pomocí Binance API)
          priceUsd, // Cena tokenu v USD z doby obchodu
          // USD hodnoty - pouze pro zobrazení
          valueUsd: computedValueUsd,
          pnlUsd: toNumber(t.pnlUsd),
          pnlPercent: toNumber(t.pnlPercent),
        };
      })
    );

    // Token metadata se načítá pouze při webhooku (nový trade)
    // Tady jen zobrazujeme data z DB - žádné enrichment, aby se neplýtvalo API kredity

    res.json({
      trades: tradesWithBaseCurrency,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  } catch (error) {
    console.error('Error fetching trades:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/trades/recalculate-all - REMOVED
// This endpoint was removed because it used Helius API (getTransactionsForAddress)
// which consumed too many API credits. We now use webhook-only approach.
// Historical recalculation is no longer supported.

// POST /api/trades/dedupe - Remove duplicate trades by txSignature (keeping the earliest)
router.post('/dedupe', async (req, res) => {
  try {
    console.log('🧹 Starting trades de-duplication by txSignature...');
    const PAGE_SIZE = 1000;
    let offset = 0;
    let total = 0;
    let fetched = 0;
    let duplicatesToDelete: string[] = [];
    const seenSignatures = new Set<string>();

    while (true) {
      const { data: rows, error, count } = await supabase
        .from(TABLES.TRADE)
        .select('id, txSignature, timestamp', { count: 'exact' })
        .order('timestamp', { ascending: true }) // keep the earliest, delete later ones
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) {
        throw new Error(`Failed to fetch trades: ${error.message}`);
      }

      const batch = rows || [];
      if (offset === 0) {
        total = count || batch.length;
      }
      fetched += batch.length;

      for (const row of batch) {
        const sig = (row as any).txSignature as string;
        const id = (row as any).id as string;
        if (!sig) continue;
        if (seenSignatures.has(sig)) {
          duplicatesToDelete.push(id);
        } else {
          seenSignatures.add(sig);
        }
      }

      console.log(`   Scanned ${fetched}/${total} trades, duplicates found so far: ${duplicatesToDelete.length}`);

      if (batch.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    // Delete duplicates in chunks
    let deleted = 0;
    const CHUNK = 500;
    for (let i = 0; i < duplicatesToDelete.length; i += CHUNK) {
      const chunk = duplicatesToDelete.slice(i, i + CHUNK);
      const { error: delErr } = await supabase
        .from(TABLES.TRADE)
        .delete()
        .in('id', chunk);
      if (delErr) {
        console.error('   ❌ Error deleting duplicate chunk:', delErr.message);
        continue;
      }
      deleted += chunk.length;
      console.log(`   ✅ Deleted ${deleted}/${duplicatesToDelete.length} duplicates`);
      // minor delay to be gentle
      await new Promise(r => setTimeout(r, 200));
    }

    console.log(`✅ De-duplication completed. Deleted ${deleted} duplicates. Unique trades: ${seenSignatures.size}`);
    res.json({ deleted, unique: seenSignatures.size, total });
  } catch (error: any) {
    console.error('❌ Error during trades de-duplication:', error);
    res.status(500).json({ error: 'Internal server error', message: error?.message });
  }
});

// GET /api/trades/recent - Get recent trades from all wallets
router.get('/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const since = req.query.since ? new Date(req.query.since as string) : undefined;

    let query = supabase
      .from(TABLES.TRADE)
      .select(`
        *,
        token:${TABLES.TOKEN}(*),
        wallet:${TABLES.SMART_WALLET}(id, address, label)
      `)
      // Recent trades feed zobrazuje BUY/SELL i VOID trades
      // VOID trades jsou token-to-token swapy bez SOL/USDC/USDT změny
      .in('side', ['buy', 'sell', 'void'])
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (since) {
      query = query.gte('timestamp', since.toISOString());
    }

    const { data: trades, error } = await query;

    if (error) {
      throw new Error(`Failed to fetch recent trades: ${error.message}`);
    }

    const tradesWithTokens = await Promise.all(
      (trades || []).map(async (trade: any) => {
        let token = trade.token;
        if (!token && trade.tokenId) {
          token = await tokenRepo.findById(trade.tokenId);
        }
        return { ...trade, token };
      })
    );

    // Token metadata se načítá pouze při webhooku (nový trade)
    // Tady jen zobrazujeme data z DB - žádné enrichment, aby se neplýtvalo API kredity

    // Format trades for notifications
    const formattedTrades = tradesWithTokens.map((trade: any) => {
      // Získej priceUsd z meta nebo vypočítej z priceBasePerToken
      let priceUsd: number | null = null;
      if (trade.meta?.priceUsd) {
        priceUsd = parseFloat(trade.meta.priceUsd);
      } else if (trade.priceBasePerToken) {
        const valuationSource = trade.meta?.valuationSource;
        const baseToken = (trade.meta?.baseToken || '').toUpperCase();
        if (
          valuationSource ||
          baseToken === 'SOL' ||
          baseToken === 'WSOL' ||
          baseToken === 'USDC' ||
          baseToken === 'USDT'
        ) {
          priceUsd = parseFloat(trade.priceBasePerToken || '0');
        } else {
          priceUsd = null;
        }
      }

      return {
        id: trade.id,
        txSignature: trade.txSignature,
        wallet: {
          id: trade.wallet?.id,
          address: trade.wallet?.address,
          label: trade.wallet?.label || trade.wallet?.address?.substring(0, 8) + '...',
        },
        token: {
          id: trade.token?.id,
          symbol: trade.token?.symbol || trade.token?.name || 'UNKNOWN',
          name: trade.token?.name,
          mintAddress: trade.token?.mintAddress,
        },
        side: trade.side,
        amountToken: parseFloat(trade.amountToken || '0'),
        amountBase: parseFloat(trade.amountBase || '0'),
        priceBasePerToken: parseFloat(trade.priceBasePerToken || '0'),
        priceUsd, // Přidej priceUsd
        baseToken: trade.meta?.baseToken || 'SOL',
        timestamp: trade.timestamp,
        dex: trade.dex,
        meta: trade.meta, // Přidej meta pro liquidityType
      };
    });

    res.json({
      trades: formattedTrades,
      total: formattedTrades.length,
    });
  } catch (error: any) {
    console.error('Error fetching recent trades:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch recent trades' });
  }
});

// GET /api/trades/consensus-notifications - Get consensus notifications (2+ wallets buying same token within 2h)
router.get('/consensus-notifications', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours as string) || 1; // Default: last 1 hour
    const limit = parseInt(req.query.limit as string) || 50;

    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    // 1. Najdi všechny BUY trades za poslední hodinu
    const { data: recentBuys, error: buysError } = await supabase
      .from(TABLES.TRADE)
      .select(`
        id,
        walletId,
        tokenId,
        timestamp,
        amountBase,
        amountToken,
        priceBasePerToken,
        txSignature,
        token:${TABLES.TOKEN}(id, symbol, name, mintAddress),
        wallet:${TABLES.SMART_WALLET}(id, address, label)
      `)
      .eq('side', 'buy')
      .neq('side', 'void')
      .gte('timestamp', since.toISOString())
      .order('timestamp', { ascending: false });

    if (buysError) {
      throw new Error(`Failed to fetch recent buys: ${buysError.message}`);
    }

    if (!recentBuys || recentBuys.length === 0) {
      return res.json({
        notifications: [],
        total: 0,
      });
    }

    // 2. Seskup trades podle tokenId a najdi consensus (2+ wallets, max 2h rozestup)
    const tokenGroups = new Map<string, typeof recentBuys>();
    for (const trade of recentBuys) {
      const tokenId = trade.tokenId;
      if (!tokenGroups.has(tokenId)) {
        tokenGroups.set(tokenId, []);
      }
      tokenGroups.get(tokenId)!.push(trade);
    }

    const consensusNotifications: any[] = [];

    for (const [tokenId, trades] of tokenGroups.entries()) {
      // Seřaď trades podle času
      const sortedTrades = trades.sort((a, b) => 
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      // Najdi skupiny trades, které jsou v rozmezí 2h
      const CONSENSUS_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
      const groups: typeof sortedTrades[] = [];
      let currentGroup: typeof sortedTrades = [];

      for (const trade of sortedTrades) {
        if (currentGroup.length === 0) {
          currentGroup.push(trade);
        } else {
          const firstTradeTime = new Date(currentGroup[0].timestamp).getTime();
          const currentTradeTime = new Date(trade.timestamp).getTime();
          
          if (currentTradeTime - firstTradeTime <= CONSENSUS_WINDOW_MS) {
            currentGroup.push(trade);
          } else {
            // Nová skupina
            if (currentGroup.length >= 2) {
              groups.push([...currentGroup]);
            }
            currentGroup = [trade];
          }
        }
      }

      // Přidej poslední skupinu, pokud má 2+ trades
      if (currentGroup.length >= 2) {
        groups.push(currentGroup);
      }

      // Pro každou skupinu vytvoř notifikaci
      for (const group of groups) {
        const uniqueWallets = new Set(group.map(t => t.walletId));
        if (uniqueWallets.size >= 2) {
          // Pro každou wallet vezmi jen první buy trade (nejstarší)
          const firstTradePerWallet = new Map<string, typeof group[0]>();
          for (const trade of group) {
            if (!firstTradePerWallet.has(trade.walletId)) {
              firstTradePerWallet.set(trade.walletId, trade);
            }
          }

          // Převod na pole a seřazení od nejnovějšího (nejnovější nahoře)
          const uniqueTrades = Array.from(firstTradePerWallet.values()).sort((a, b) => 
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
          );

          const latestTrade = uniqueTrades[0]; // Nejnovější
          const firstTrade = uniqueTrades[uniqueTrades.length - 1]; // Nejstarší

          // Zkontroluj, jestli už není notifikace pro tento token a časové okno
          const existingNotification = consensusNotifications.find(n => 
            n.tokenId === tokenId &&
            Math.abs(new Date(n.firstTradeTime).getTime() - new Date(firstTrade.timestamp).getTime()) < CONSENSUS_WINDOW_MS
          );

          if (!existingNotification) {
            consensusNotifications.push({
              id: `consensus-${tokenId}-${firstTrade.timestamp}`,
              tokenId,
              token: latestTrade.token,
              walletCount: uniqueWallets.size,
              trades: uniqueTrades.map((t: any) => {
                const wallet = Array.isArray(t.wallet) ? t.wallet[0] : t.wallet;
                return {
                  id: t.id,
                  wallet: {
                    id: wallet?.id,
                    address: wallet?.address,
                    label: wallet?.label || wallet?.address?.substring(0, 8) + '...',
                  },
                  amountBase: parseFloat(t.amountBase || '0'),
                  amountToken: parseFloat(t.amountToken || '0'),
                  priceBasePerToken: parseFloat(t.priceBasePerToken || '0'),
                  timestamp: t.timestamp,
                  txSignature: t.txSignature,
                };
              }),
              firstTradeTime: firstTrade.timestamp,
              latestTradeTime: latestTrade.timestamp,
              createdAt: new Date().toISOString(),
            });
          } else {
            // Aktualizuj existující notifikaci - přidej nové wallets (jen první buy pro každou)
            const existingWalletIds = new Set(existingNotification.trades.map((et: any) => et.wallet.id));
            const newWallets = uniqueTrades.filter(t => {
              const wallet = Array.isArray(t.wallet) ? t.wallet[0] : t.wallet;
              return wallet?.id && !existingWalletIds.has(wallet.id);
            });

            if (newWallets.length > 0) {
              // Přidej nové trades a seřaď od nejnovějšího
              const allTrades = [
                ...newWallets.map((t: any) => {
                  const wallet = Array.isArray(t.wallet) ? t.wallet[0] : t.wallet;
                  return {
                    id: t.id,
                    wallet: {
                      id: wallet?.id,
                      address: wallet?.address,
                      label: wallet?.label || wallet?.address?.substring(0, 8) + '...',
                    },
                    amountBase: parseFloat(t.amountBase || '0'),
                    amountToken: parseFloat(t.amountToken || '0'),
                    priceBasePerToken: parseFloat(t.priceBasePerToken || '0'),
                    timestamp: t.timestamp,
                    txSignature: t.txSignature,
                  };
                }),
                ...existingNotification.trades
              ].sort((a, b) => 
                new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
              );

              existingNotification.trades = allTrades;
              existingNotification.walletCount = new Set(allTrades.map((t: any) => t.wallet.id)).size;
              existingNotification.latestTradeTime = latestTrade.timestamp;
              // Aktualizuj createdAt, aby se notifikace přesunula nahoru
              existingNotification.createdAt = new Date().toISOString();
            }
          }
        }
      }
    }

    // Seřaď podle nejnovějšího času
    consensusNotifications.sort((a, b) => 
      new Date(b.latestTradeTime).getTime() - new Date(a.latestTradeTime).getTime()
    );

    // Omez na limit
    const limited = consensusNotifications.slice(0, limit);

    // Fetch token security data for each notification (honeypot, tax, holders, etc.)
    const tokenMintAddresses = [...new Set(limited.map(n => n.token?.mintAddress).filter(Boolean))];
    const tokenSecurityData = new Map<string, any>();
    
    // TODO: Implement token security data fetching from Birdeye API
    // For now, return empty security data
    for (const mintAddress of tokenMintAddresses) {
      tokenSecurityData.set(mintAddress, {
        honeypot: null,
        buyTax: null,
        sellTax: null,
        marketCap: null,
        holdersCount: null,
        tokenAgeMinutes: null,
        lpLocked: null,
        top10HoldersPercent: null,
      });
    }

    // Add security data to notifications
    const notificationsWithSecurity = limited.map(notification => ({
      ...notification,
      tokenSecurity: notification.token?.mintAddress 
        ? tokenSecurityData.get(notification.token.mintAddress) || null
        : null,
    }));

    res.json({
      notifications: notificationsWithSecurity,
      total: consensusNotifications.length,
    });
  } catch (error: any) {
    console.error('Error fetching consensus notifications:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch consensus notifications' });
  }
});

export { router as tradesRouter };
