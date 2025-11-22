import { Router } from 'express';
import { TradeRepository } from '../repositories/trade.repository.js';
import { HeliusClient } from '../services/helius-client.service.js';
import { SolPriceService } from '../services/sol-price.service.js';
import { TokenPriceService } from '../services/token-price.service.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';
import { supabase, TABLES } from '../lib/supabase.js';
import { TokenMetadataBatchService } from '../services/token-metadata-batch.service.js';
import { SolscanClient } from '../services/solscan-client.service.js';
import { BinancePriceService } from '../services/binance-price.service.js';

const router = Router();
const tradeRepo = new TradeRepository();
const heliusClient = new HeliusClient();
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
const tokenMetadataBatchService = new TokenMetadataBatchService(heliusClient, tokenRepo);
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
        
        // Vypočítej USD cenu tokenu pomocí historické ceny SOL/USDT z Binance
        // Vzorec: priceUsd = priceBasePerToken * solPriceUsd
        let priceUsd: number | null = null;
        if (baseToken === 'SOL' && priceBasePerToken > 0) {
          try {
            const tradeTimestamp = new Date(t.timestamp);
            const solPriceUsd = await binancePriceService.getSolPriceAtTimestamp(tradeTimestamp);
            priceUsd = priceBasePerToken * solPriceUsd;
          } catch (error: any) {
            console.warn(`Failed to fetch SOL price from Binance for trade ${t.txSignature}: ${error.message}`);
            // Použij existující valueUsd jako fallback, pokud je k dispozici
            priceUsd = t.valueUsd != null && toNumber(t.valueUsd) != null && toNumber(t.valueUsd) > 0 && amountToken > 0 
              ? toNumber(t.valueUsd)! / amountToken 
              : null;
          }
        } else if (baseToken === 'USDC' || baseToken === 'USDT') {
          // Pro USDC/USDT: 1:1 s USD
          priceUsd = priceBasePerToken;
        }

        return {
          ...t,
          token,
          amountToken,
          amountBase,
          priceBasePerToken,
          // entryPrice = priceBasePerToken (cena v base měně za 1 token)
          entryPrice: priceBasePerToken,
          // entryCost (pro BUY) nebo proceedsBase (pro SELL) = amountBase
          entryCost: t.side === 'buy' ? amountBase : null,
          proceedsBase: t.side === 'sell' ? amountBase : null,
          baseToken, // SOL, USDC, USDT
          // USD cena tokenu (vypočítaná pomocí Binance API)
          priceUsd, // Cena tokenu v USD z doby obchodu
          // USD hodnoty - pouze pro zobrazení
          valueUsd: priceUsd && amountToken > 0 ? priceUsd * amountToken : toNumber(t.valueUsd),
          pnlUsd: toNumber(t.pnlUsd),
          pnlPercent: toNumber(t.pnlPercent),
          positionChangePercent: toNumber(t.positionChangePercent),
        };
      })
    );

    // Token metadata are already in DB from webhook processing - no enrichment needed
    // UI will use token.symbol and token.name from database

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

// POST /api/trades/recalculate-all - Re-process all trades with fixed logic
router.post('/recalculate-all', async (req, res) => {
  try {
    console.log('🔄 Starting recalculation of all trades...');
    
    // Okamžitě vrať odpověď - processing poběží na pozadí
    res.status(202).json({
      message: 'Recalculation started in background',
      status: 'processing',
    });

    // Spusť processing na pozadí
    (async () => {
      try {
        let processed = 0;
        let updated = 0;
        let errors = 0;
        const BATCH_SIZE = 50;
        let offset = 0;

        // Cache pro Helius transakce (wallet address -> transactions map)
        const walletTxCache = new Map<string, Map<string, any>>();

        while (true) {
          // Načti batch tradeů
          const result = await tradeRepo.findAll(BATCH_SIZE, offset);
          const trades = result.trades;

          if (trades.length === 0) {
            break; // Konec
          }

          console.log(`📦 Processing batch: ${offset + 1}-${offset + trades.length} of ${result.total}...`);

          // OPTIMALIZACE: Seskup trady podle walletky, abychom načetli transakce jen jednou
          const tradesByWallet = new Map<string, any[]>();
          for (const trade of trades) {
            const walletId = trade.walletId;
            if (!tradesByWallet.has(walletId)) {
              tradesByWallet.set(walletId, []);
            }
            tradesByWallet.get(walletId)!.push(trade);
          }

          // Pro každou walletku načti transakce jednou
          for (const [walletId, walletTrades] of tradesByWallet.entries()) {
            try {
              // Získej wallet address
              const wallet = await smartWalletRepo.findById(walletId);
              if (!wallet) {
                console.log(`   ⚠️  Wallet ${walletId} not found, skipping ${walletTrades.length} trades`);
                errors += walletTrades.length;
                continue;
              }

              // Historical transaction fetching removed - only webhook processing uses Helius API
              // Recalculation endpoint disabled - trades are only processed via webhooks
              console.log(`   ⚠️  Skipping wallet ${wallet.address.substring(0, 8)}... - recalculation disabled (webhook-only mode)`);
              errors += walletTrades.length;
              // Note: All trade processing code below was removed - only webhook processing is enabled

              // Delay mezi walletkami
              await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error: any) {
              console.error(`   ❌ Error processing wallet ${walletId}:`, error.message);
              errors += walletTrades.length;
            }
          }

          offset += BATCH_SIZE;

          // Delay mezi batchy
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        console.log(`✅ Recalculation completed:`);
        console.log(`   - Processed: ${processed}`);
        console.log(`   - Updated: ${updated}`);
        console.log(`   - Errors: ${errors}`);

        // Po dokončení přepočítej metriky pro všechny walletky
        console.log('📊 Recalculating metrics for all wallets...');
        const wallets = await smartWalletRepo.findAll({ page: 1, pageSize: 10000 });
        for (const wallet of wallets.wallets) {
          try {
            await metricsCalculator.calculateMetricsForWallet(wallet.id);
          } catch (error: any) {
            console.error(`   ❌ Error calculating metrics for wallet ${wallet.id}:`, error.message);
          }
        }
        console.log('✅ Metrics recalculation completed');
      } catch (error: any) {
        console.error('❌ Error in background recalculation:', error);
      }
    })();

  } catch (error: any) {
    console.error('Error starting recalculation:', error);
    res.status(500).json({ error: 'Internal server error', message: error?.message });
  }
});

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

    // Token metadata are already in DB from webhook processing - no enrichment needed
    // UI will use token.symbol and token.name from database

    // Format trades for notifications
    const formattedTrades = tradesWithTokens.map((trade: any) => {
      // Získej priceUsd z meta nebo vypočítej z priceBasePerToken
      let priceUsd: number | null = null;
      if (trade.meta?.priceUsd) {
        priceUsd = parseFloat(trade.meta.priceUsd);
      } else if (trade.priceBasePerToken) {
        // Fallback: pokud není priceUsd v meta, použij priceBasePerToken
        // (frontend to může přepočítat pomocí Binance API)
        priceUsd = null; // Frontend to přepočítá
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
        side: trade.side, // Může být 'buy', 'sell', 'add', 'remove'
        amountToken: parseFloat(trade.amountToken || '0'),
        amountBase: parseFloat(trade.amountBase || '0'),
        priceBasePerToken: parseFloat(trade.priceBasePerToken || '0'),
        priceUsd, // Přidej priceUsd
        baseToken: trade.meta?.baseToken || 'SOL',
        timestamp: trade.timestamp,
        dex: trade.dex,
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

export { router as tradesRouter };

