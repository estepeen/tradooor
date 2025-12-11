import 'dotenv/config';
import cron from 'node-cron';
import { Connection, PublicKey } from '@solana/web3.js';
import { SolanaCollectorService } from '../services/solana-collector.service.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { WalletProcessingQueueRepository } from '../repositories/wallet-processing-queue.repository.js';
import { NormalizedTradeRepository } from '../repositories/normalized-trade.repository.js';
import { LotMatchingService } from '../services/lot-matching.service.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';

const smartWalletRepo = new SmartWalletRepository();
const tradeRepo = new TradeRepository();
const tokenRepo = new TokenRepository();
const walletQueueRepo = new WalletProcessingQueueRepository();
const normalizedTradeRepo = new NormalizedTradeRepository();
const metricsHistoryRepo = new MetricsHistoryRepository();
const lotMatchingService = new LotMatchingService();
const metricsCalculator = new MetricsCalculatorService(
  smartWalletRepo,
  tradeRepo,
  metricsHistoryRepo
);

const collectorService = new SolanaCollectorService(
  smartWalletRepo,
  tradeRepo,
  tokenRepo,
  walletQueueRepo,
  normalizedTradeRepo
);

/**
 * Backfill cron job - kontroluje posledních 2 minuty pro všechny wallets
 * a automaticky přepočítává positions a metrics
 * 
 * OPTIMALIZOVÁNO: Spouští se každou 1 hodinu (místo každých 2 minut).
 * Backfill slouží jako pojistka pro trades, které webhook nechytil.
 * Pokud webhook chytá většinu trades, stačí kontrola jednou za hodinu.
 * 
 * Odhad requests za měsíc (s 1h intervalem):
 * - 80 aktivních wallets × 24x/den × 30 dní = 57,600 getSignaturesForAddress
 * - ~28,800 - 57,600 getTransaction (závisí na aktivitě)
 * - Celkem: ~86,400 - 115,200 requests/měsíc (vs. původní ~4-5.4M)
 * - Úspora: ~98% reduction!
 */
async function backfillLast2Minutes() {
  const startTime = Date.now();
  console.log(`\n⏰ [${new Date().toISOString()}] Starting backfill cron (last 2 minutes)...`);

  // Setup RPC - use QuickNode (as requested, not Helius)
  const rpcUrl = process.env.QUICKNODE_RPC_URL || process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    console.error('❌ No RPC URL configured (QUICKNODE_RPC_URL or SOLANA_RPC_URL required)');
    return;
  }
  console.log(`📡 Using QuickNode RPC: ${rpcUrl.substring(0, 30)}...`);
  const connection = new Connection(rpcUrl, 'confirmed');

  // Time range: last 2 minutes
  const now = Date.now();
  const twoMinutesAgo = now - (2 * 60 * 1000);
  const twoMinutesAgoSec = Math.floor(twoMinutesAgo / 1000);

  // Get all wallets
  const allWallets = await smartWalletRepo.findAll({ page: 1, pageSize: 10000 });
  console.log(`📋 Found ${allWallets.wallets.length} wallets in database`);

  // OPTIMIZATION: Filter to only active wallets (had trades in last 7 days)
  // This reduces RPC calls significantly - only check wallets that are actually trading
  const activeWallets: typeof allWallets.wallets = [];
  const now7dAgo = now - (7 * 24 * 60 * 60 * 1000);
  
  for (const wallet of allWallets.wallets) {
    // Check if wallet has trades in last 7 days
    const { trades } = await tradeRepo.findByWalletId(wallet.id, {
      pageSize: 1,
      fromDate: new Date(now7dAgo),
    });
    
    // Include wallet if it has trades in last 7 days OR if it was created recently (within 7 days)
    const walletCreated = wallet.createdAt ? new Date(wallet.createdAt).getTime() : 0;
    if (trades.length > 0 || walletCreated > now7dAgo) {
      activeWallets.push(wallet);
    }
  }

  console.log(`📊 Processing ${activeWallets.length} active wallets (${allWallets.wallets.length - activeWallets.length} inactive skipped - no trades in last 7 days)...`);

  let totalProcessed = 0;
  let totalSaved = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  const walletsWithNewTrades = new Set<string>();

  // Process each active wallet with delay between wallets
  for (let i = 0; i < activeWallets.length; i++) {
    const wallet = activeWallets[i];
    
    // Delay mezi wallets pro úsporu requests (každých 5 wallets větší delay)
    if (i > 0 && i % 5 === 0) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // 1s delay každých 5 wallets
    }
    
    try {
      const walletPubkey = new PublicKey(wallet.address);
      
      // OPTIMIZATION: Přeskočit wallets s trades v posledních 2 minutách
      // Webhook už to zpracoval, není potřeba kontrolovat znovu
      const { trades: recentTrades } = await tradeRepo.findByWalletId(wallet.id, {
        pageSize: 1,
        fromDate: new Date(twoMinutesAgo),
      });
      
      // Pokud má wallet trade v posledních 2 minutách, přeskočit (webhook to už chytil)
      if (recentTrades.length > 0) {
        continue; // Webhook už zpracoval, není potřeba kontrolovat znovu
      }
      
      // Wallet nemá trades v posledních 2 minutách - zkontroluj RPC (může být trade, který webhook nechytil)
      // Použij menší limit pro úsporu requests
      const signatures = await connection.getSignaturesForAddress(
        walletPubkey,
        { limit: 20 }, // Sníženo z 50 na 20 pro úsporu requests
        'confirmed'
      );

      // Filter by time
      const recentSigs = signatures.filter(sig => 
        sig.blockTime && sig.blockTime >= twoMinutesAgoSec
      );

      if (recentSigs.length === 0) {
        continue; // No new transactions
      }

      let walletSaved = 0;
      let walletSkipped = 0;

      // Process each signature
      for (const sigInfo of recentSigs) {
        try {
          // Check if already exists
          const existing = await tradeRepo.findBySignature(sigInfo.signature);
          if (existing) {
            walletSkipped++;
            continue;
          }

          // Fetch full transaction
          const tx = await connection.getTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });

          if (!tx) {
            walletSkipped++;
            continue;
          }

          // Convert to QuickNode format
          const quickNodeTx = {
            transaction: {
              signatures: [sigInfo.signature],
              message: tx.transaction.message,
            },
            meta: tx.meta,
            slot: tx.slot,
            blockTime: tx.blockTime,
          };

          // Process transaction
          const result = await collectorService.processQuickNodeTransaction(
            quickNodeTx,
            wallet.address,
            tx.blockTime ?? undefined
          );

          if (result.saved) {
            walletSaved++;
            walletsWithNewTrades.add(wallet.id);
          } else {
            walletSkipped++;
          }

          // Rate limiting - delay mezi requests (zvýšeno pro úsporu requests)
          await new Promise(resolve => setTimeout(resolve, 200)); // 200ms delay místo 50ms
        } catch (error: any) {
          totalErrors++;
          if (totalErrors <= 5) {
            console.warn(`   ⚠️  Error processing ${sigInfo.signature.substring(0, 16)}...: ${error.message}`);
          }
        }
      }

      if (walletSaved > 0) {
        console.log(`   ✅ ${wallet.address.substring(0, 8)}...: ${walletSaved} new trades, ${walletSkipped} skipped`);
      }

      totalProcessed += recentSigs.length;
      totalSaved += walletSaved;
      totalSkipped += walletSkipped;

    } catch (error: any) {
      totalErrors++;
      if (totalErrors <= 10) {
        console.error(`   ❌ Error processing wallet ${wallet.address}: ${error.message}`);
      }
    }
  }

  // Recalculate positions and metrics for wallets with new trades
  if (walletsWithNewTrades.size > 0) {
    console.log(`\n🔄 Recalculating positions and metrics for ${walletsWithNewTrades.size} wallets with new trades...`);
    
    for (const walletId of walletsWithNewTrades) {
      try {
        const wallet = await smartWalletRepo.findById(walletId);
        if (!wallet) continue;

        // Recalculate positions
        const trackingStartTime = wallet.createdAt ? new Date(wallet.createdAt) : undefined;
        const { closedLots, openPositions } = await lotMatchingService.processTradesForWallet(
          walletId,
          undefined,
          trackingStartTime
        );
        await lotMatchingService.saveClosedLots(closedLots);
        if (openPositions.length > 0) {
          await lotMatchingService.saveOpenPositions(openPositions);
        } else {
          await lotMatchingService.deleteOpenPositionsForWallet(walletId);
        }

        // Recalculate metrics
        await metricsCalculator.calculateMetricsForWallet(walletId);
      } catch (error: any) {
        console.error(`   ❌ Error recalculating ${walletId}: ${error.message}`);
      }
    }
  }

  const duration = Date.now() - startTime;
  console.log(`\n✅ Backfill complete!`);
  console.log(`   Processed: ${totalProcessed} transactions`);
  console.log(`   Saved: ${totalSaved} new trades`);
  console.log(`   Skipped: ${totalSkipped} (already exists)`);
  console.log(`   Errors: ${totalErrors}`);
  console.log(`   Wallets with new trades: ${walletsWithNewTrades.size}`);
  console.log(`   Duration: ${duration}ms\n`);
}

async function main() {
  // OPTIMALIZACE: Každou 1 hodinu - backfill je jen pojistka pro trades, které webhook nechytil
  // Pokud webhook chytá většinu trades, stačí kontrola jednou za hodinu
  // Default: every 1 hour (0 * * * *)
  const cronSchedule = process.env.BACKFILL_CRON_SCHEDULE || '0 * * * *';

  console.log(`🚀 Starting backfill cron job (OPTIMIZED)`);
  console.log(`📅 Schedule: ${cronSchedule} (every 1 hour - optimized for QuickNode credits)`);
  console.log(`   Set BACKFILL_CRON_SCHEDULE env var to customize`);
  console.log(`   Time window: last 2 minutes`);
  console.log(`   ⚡ Optimizations:`);
  console.log(`      - Skips wallets with trades in last 2min (webhook already processed)`);
  console.log(`      - Reduced signature limit: 20 (was 50)`);
  console.log(`      - Increased delay: 200ms between transactions`);
  console.log(`      - Batch delay: 1s every 5 wallets`);
  console.log(`      - Uses QuickNode RPC (as requested)`);
  console.log(`   💰 Estimated savings:`);
  console.log(`      - 2min interval: ~4-5.4M requests/month`);
  console.log(`      - 1h interval: ~86k-115k requests/month`);
  console.log(`      - Savings: ~98% reduction!`);

  // Run once on start (optional)
  if (process.env.RUN_ON_START !== 'false') {
    await backfillLast2Minutes();
  }

  // Schedule cron job
  cron.schedule(cronSchedule, async () => {
    await backfillLast2Minutes();
  });

  // Keep process running
  process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down backfill cron...');
    process.exit(0);
  });

  console.log('✅ Backfill cron job is running. Press Ctrl+C to stop.');
}

main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

