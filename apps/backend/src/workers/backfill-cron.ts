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
 * Spouští se každé 2 minuty.
 * 
 * Odhad requests za měsíc:
 * - 126 wallets × 30x/hodinu × 24h × 30 dní = 2,721,600 getSignaturesForAddress
 * - ~1.36M - 2.72M getTransaction (závisí na aktivitě)
 * - Celkem: ~4-5.4M requests/měsíc (stále v rámci 7.5M credits)
 */
async function backfillLast2Minutes() {
  const startTime = Date.now();
  console.log(`\n⏰ [${new Date().toISOString()}] Starting backfill cron (last 2 minutes)...`);

  // Setup RPC
  const rpcUrl = process.env.QUICKNODE_RPC_URL || process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    console.error('❌ No RPC URL configured');
    return;
  }
  const connection = new Connection(rpcUrl, 'confirmed');

  // Time range: last 2 minutes
  const now = Date.now();
  const twoMinutesAgo = now - (2 * 60 * 1000);
  const twoMinutesAgoSec = Math.floor(twoMinutesAgo / 1000);

  // Get all wallets
  const allWallets = await smartWalletRepo.findAll({ page: 1, pageSize: 10000 });
  console.log(`📋 Found ${allWallets.wallets.length} wallets in database`);

  // OPTIMIZATION: Filter to only active wallets (had trades in last 24h)
  // This reduces RPC calls significantly
  const activeWallets: typeof allWallets.wallets = [];
  const now24hAgo = now - (24 * 60 * 60 * 1000);
  
  for (const wallet of allWallets.wallets) {
    // Check if wallet has trades in last 24h
    const { trades } = await tradeRepo.findByWalletId(wallet.id, {
      pageSize: 1,
      fromDate: new Date(now24hAgo),
    });
    
    // Include wallet if it has trades in last 24h OR if it was created recently (within 24h)
    const walletCreated = wallet.createdAt ? new Date(wallet.createdAt).getTime() : 0;
    if (trades.length > 0 || walletCreated > now24hAgo) {
      activeWallets.push(wallet);
    }
  }

  console.log(`📊 Processing ${activeWallets.length} active wallets (${allWallets.wallets.length - activeWallets.length} inactive skipped)...`);

  let totalProcessed = 0;
  let totalSaved = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  const walletsWithNewTrades = new Set<string>();

  // Process each active wallet
  for (const wallet of activeWallets) {
    try {
      const walletPubkey = new PublicKey(wallet.address);
      
      // OPTIMIZATION: Get last trade timestamp to skip if no activity since last check
      // This avoids unnecessary RPC calls for inactive wallets
      const { trades: recentTrades } = await tradeRepo.findByWalletId(wallet.id, {
        pageSize: 1,
        fromDate: new Date(twoMinutesAgo),
      });
      
      // If wallet has no trades in last 2 minutes, skip RPC call
      // (This is a quick DB check before expensive RPC call)
      if (recentTrades.length === 0) {
        // Still check RPC, but with smaller limit
        const signatures = await connection.getSignaturesForAddress(
          walletPubkey,
          { limit: 10 }, // Smaller limit for inactive wallets
          'confirmed'
        );

        const recentSigs = signatures.filter(sig => 
          sig.blockTime && sig.blockTime >= twoMinutesAgoSec
        );

        if (recentSigs.length === 0) {
          continue; // No new transactions
        }
      } else {
        // Wallet has recent trades, check RPC with normal limit
        const signatures = await connection.getSignaturesForAddress(
          walletPubkey,
          { limit: 50 },
          'confirmed'
        );

        const recentSigs = signatures.filter(sig => 
          sig.blockTime && sig.blockTime >= twoMinutesAgoSec
        );

        if (recentSigs.length === 0) {
          continue; // No new transactions
        }
      }

      // Get signatures (if we didn't already)
      const signatures = await connection.getSignaturesForAddress(
        walletPubkey,
        { limit: 50 },
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
            tx.blockTime
          );

          if (result.saved) {
            walletSaved++;
            walletsWithNewTrades.add(wallet.id);
          } else {
            walletSkipped++;
          }

          // Rate limiting - small delay to avoid hitting limits
          await new Promise(resolve => setTimeout(resolve, 50));
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
        const closedLots = await lotMatchingService.processTradesForWallet(
          walletId,
          undefined,
          trackingStartTime
        );
        await lotMatchingService.saveClosedLots(closedLots);

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
  // Default: every 2 minutes (*/2 * * * *)
  const cronSchedule = process.env.BACKFILL_CRON_SCHEDULE || '*/2 * * * *';

  console.log(`🚀 Starting backfill cron job`);
  console.log(`📅 Schedule: ${cronSchedule} (every 2 minutes)`);
  console.log(`   Set BACKFILL_CRON_SCHEDULE env var to customize`);
  console.log(`   Time window: last 2 minutes`);

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

