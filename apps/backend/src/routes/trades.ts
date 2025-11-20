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

    // Always ensure token metadata is available so UI can render tickers/names
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
    const tokensToEnrich = new Map<string, { token: any }>();

    for (const trade of tradesWithBaseCurrency as any[]) {
      const token = trade.token || trade.Token;
      if (!token || !token.mintAddress) continue;

      const symbol = (token.symbol || '').trim();
      const name = (token.name || '').trim();
      const looksLikeAddress = symbol.length > 15 && base58Regex.test(symbol);
      const looksLikeTruncated = symbol.includes('...');

      if (!symbol && !name) {
        tokensToEnrich.set(token.mintAddress, { token });
      } else if (looksLikeAddress || looksLikeTruncated) {
        tokensToEnrich.set(token.mintAddress, { token });
      }
    }

    if (tokensToEnrich.size > 0) {
      console.log(`   🔍 Enriching metadata for ${tokensToEnrich.size} token(s) used in trades...`);
      try {
        const metadataMap = await tokenMetadataBatchService.getTokenMetadataBatch(
          Array.from(tokensToEnrich.keys())
        );

        await Promise.all(
          Array.from(tokensToEnrich.entries()).map(async ([mintAddress, { token }]) => {
            const metadata = metadataMap.get(mintAddress);
            if (!metadata) return;

            const nextSymbol = metadata.symbol ?? token.symbol ?? null;
            const nextName = metadata.name ?? token.name ?? null;
            const nextDecimals =
              metadata.decimals !== undefined && metadata.decimals !== null
                ? metadata.decimals
                : token.decimals;

            token.symbol = nextSymbol;
            token.name = nextName;
            token.decimals = nextDecimals;

            if (token.id) {
              try {
                await tokenRepo.update(token.id, {
                  symbol: nextSymbol,
                  name: nextName,
                  decimals: nextDecimals,
                });
              } catch (updateError: any) {
                console.warn(
                  `   ⚠️  Failed to persist metadata for token ${mintAddress}:`,
                  updateError?.message || updateError
                );
              }
            }
          })
        );

        console.log(`   ✅ Token metadata enrichment completed (${metadataMap.size} token(s) updated)`);
      } catch (e: any) {
        console.warn('⚠️  Failed to enrich token metadata for trades:', e?.message || e);
      }
    }

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

              // Získej transakce z cache nebo z Helius API
              let txMap = walletTxCache.get(wallet.address);
              if (!txMap) {
                // Načti všechny transakce pro tuto walletku (až 500 pro jistotu)
                console.log(`   🔍 Loading transactions for wallet ${wallet.address.substring(0, 8)}...`);
                txMap = new Map<string, any>();
                
                let lastSignature: string | undefined = undefined;
                for (let i = 0; i < 5; i++) { // Max 5 batchů = 500 transakcí
                  const transactions = await heliusClient.getTransactionsForAddress(wallet.address, {
                    limit: 100,
                    before: lastSignature,
                  });
                  
                  for (const tx of transactions) {
                    txMap.set(tx.signature, tx);
                  }
                  
                  if (transactions.length < 100) {
                    break; // Konec
                  }
                  
                  lastSignature = transactions[transactions.length - 1]?.signature;
                  
                  // Delay mezi batchy
                  await new Promise(resolve => setTimeout(resolve, 500));
                }
                
                walletTxCache.set(wallet.address, txMap);
                console.log(`   ✅ Loaded ${txMap.size} transactions for wallet ${wallet.address.substring(0, 8)}...`);
              }

              // Zpracuj všechny trady pro tuto walletku
              for (const trade of walletTrades) {
                try {
                  processed++;
                  
                  // Najdi transakci v cache
                  const tx = txMap.get(trade.txSignature);
                  if (!tx) {
                    console.log(`   ⚠️  Trade ${trade.id}: Transaction ${trade.txSignature.substring(0, 16)}... not found in cache, skipping`);
                    errors++;
                    continue;
                  }

              // Znovu normalizuj swap s opravenou logikou
              const swap = heliusClient.normalizeSwap(tx as any, wallet.address);
              if (!swap) {
                console.log(`   ⚠️  Trade ${trade.id}: Failed to normalize swap, skipping`);
                errors++;
                continue;
              }

              // Zkontroluj, jestli se hodnoty změnily
              const oldAmountBase = Number(trade.amountBase);
              const newAmountBase = swap.amountBase;
              
              if (Math.abs(oldAmountBase - newAmountBase) < 0.000001) {
                // Hodnoty se nezměnily - přeskoč
                continue;
              }

              // Přepočítej valueUsd pomocí ceny tokenu z Birdeye API (historická cena z doby transakce)
              let valueUsd = 0;
              const tokenPriceUsd = await tokenPriceService.getTokenPriceAtDate(swap.tokenMint, trade.timestamp);
              if (tokenPriceUsd !== null && tokenPriceUsd > 0) {
                valueUsd = swap.amountToken * tokenPriceUsd;
              } else {
                // Fallback: použij SOL cenu pokud Birdeye nemá cenu tokenu
                valueUsd = await solPriceService.solToUsdAtDate(swap.amountBase, trade.timestamp);
              }

              // Přepočítej positionChangePercent
              const allTrades = await tradeRepo.findAllForMetrics(wallet.id);
              const tokenTrades = allTrades
                .filter(t => t.tokenId === trade.tokenId)
                .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

              let currentPosition = 0;
              for (const prevTrade of tokenTrades) {
                if (prevTrade.txSignature === trade.txSignature) {
                  break;
                }
                if (prevTrade.side === 'buy') {
                  currentPosition += Number(prevTrade.amountToken);
                } else if (prevTrade.side === 'sell') {
                  currentPosition -= Number(prevTrade.amountToken);
                }
              }

              let positionChangePercent: number | undefined = undefined;
              const MIN_POSITION_THRESHOLD = swap.amountToken * 0.01;

              if (swap.side === 'buy') {
                if (currentPosition > MIN_POSITION_THRESHOLD) {
                  positionChangePercent = (swap.amountToken / currentPosition) * 100;
                  if (positionChangePercent > 1000) {
                    positionChangePercent = 100;
                  }
                } else {
                  positionChangePercent = 100;
                }
              } else if (swap.side === 'sell') {
                if (currentPosition > MIN_POSITION_THRESHOLD) {
                  positionChangePercent = -(swap.amountToken / currentPosition) * 100;
                  if (positionChangePercent < -100) {
                    positionChangePercent = -100;
                  }
                  if (Math.abs(positionChangePercent) > 1000) {
                    positionChangePercent = -100;
                  }
                } else {
                  if (swap.amountToken > currentPosition) {
                    positionChangePercent = -100;
                  } else {
                    positionChangePercent = currentPosition > 0 
                      ? -(swap.amountToken / currentPosition) * 100 
                      : 0;
                  }
                }
              }

              // Přepočítej PnL pro sell
              let pnlUsd: number | undefined = undefined;
              let pnlPercent: number | undefined = undefined;

              if (swap.side === 'sell') {
                const openBuys = tokenTrades
                  .filter(t => t.side === 'buy' && t.txSignature !== trade.txSignature)
                  .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

                const matchingBuy = openBuys.find(buy => {
                  const sellsAfterBuy = tokenTrades.filter(t => 
                    t.side === 'sell' && 
                    new Date(t.timestamp) > new Date(buy.timestamp) &&
                    t.txSignature !== trade.txSignature
                  );
                  return sellsAfterBuy.length === 0;
                });

                if (matchingBuy) {
                  // Použij historickou cenu tokenu z Birdeye z doby buy trade
                  const buyTokenPriceUsd = await tokenPriceService.getTokenPriceAtDate(swap.tokenMint, matchingBuy.timestamp);
                  let buyValueUsd = 0;
                  if (buyTokenPriceUsd !== null && buyTokenPriceUsd > 0) {
                    buyValueUsd = Number(matchingBuy.amountToken) * buyTokenPriceUsd;
                  } else {
                    // Fallback: použij SOL cenu
                    buyValueUsd = await solPriceService.solToUsdAtDate(Number(matchingBuy.amountBase), matchingBuy.timestamp);
                  }
                  pnlUsd = valueUsd - buyValueUsd;
                  pnlPercent = buyValueUsd > 0 ? (pnlUsd / buyValueUsd) * 100 : 0;
                }
              }

              // Aktualizuj trade
              await tradeRepo.update(trade.id, {
                amountBase: swap.amountBase,
                priceBasePerToken: swap.priceBasePerToken,
                valueUsd,
                pnlUsd,
                pnlPercent,
                positionChangePercent,
              });

                  updated++;
                  
                  if (updated % 10 === 0) {
                    console.log(`   ✅ Updated ${updated} trades so far...`);
                  }
                } catch (error: any) {
                  console.error(`   ❌ Error processing trade ${trade.id}:`, error.message);
                  errors++;
                }
              }

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

    // Ensure token metadata is available (symbol/name) for notifications + tables
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
    const tokensToEnrich = new Map<string, any>();
    for (const trade of tradesWithTokens) {
      const token = trade.token;
      if (!token || !token.mintAddress) continue;

      const symbol = (token.symbol || '').trim();
      const name = (token.name || '').trim();
      const looksLikeAddress = symbol.length > 15 && base58Regex.test(symbol);
      const looksLikeTruncated = symbol.includes('...');

      if (!symbol && !name) {
        tokensToEnrich.set(token.mintAddress, token);
      } else if (looksLikeAddress || looksLikeTruncated) {
        tokensToEnrich.set(token.mintAddress, token);
      }
    }

    if (tokensToEnrich.size > 0) {
      try {
        const metadataMap = await tokenMetadataBatchService.getTokenMetadataBatch(
          Array.from(tokensToEnrich.keys())
        );

        await Promise.all(
          Array.from(tokensToEnrich.entries()).map(async ([mint, token]) => {
            const metadata = metadataMap.get(mint);
            if (!metadata) return;

            const nextSymbol = metadata.symbol ?? token.symbol ?? null;
            const nextName = metadata.name ?? token.name ?? null;
            const nextDecimals =
              metadata.decimals !== undefined && metadata.decimals !== null
                ? metadata.decimals
                : token.decimals;

            token.symbol = nextSymbol;
            token.name = nextName;
            token.decimals = nextDecimals;

            if (token.id) {
              try {
                await tokenRepo.update(token.id, {
                  symbol: nextSymbol,
                  name: nextName,
                  decimals: nextDecimals,
                });
              } catch (updateError: any) {
                console.warn(
                  `⚠️  Failed to persist metadata for token ${mint}:`,
                  updateError?.message || updateError
                );
              }
            }
          })
        );
      } catch (metadataError: any) {
        console.warn('⚠️  Failed to enrich token metadata for recent trades:', metadataError?.message || metadataError);
      }
    }

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

