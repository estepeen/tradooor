/**
 * Periodický job pro kontrolu chybějících trades pomocí RPC
 * 
 * Každou hodinu kontroluje všechny peněženky a hledá trades, které webhook mohl vynechat.
 * 
 * Datový tok:
 * 1. Projde všechny wallet adresy
 * 2. Pro každou wallet získá transakce z RPC za poslední hodinu
 * 3. Porovná s trades v DB
 * 4. Pokud najde chybějící, zpracuje je pomocí SolanaCollectorService
 * 
 * Použití:
 *   pnpm --filter backend check-missing-trades:cron
 * 
 * Nebo s vlastním cron schedule (každou hodinu):
 *   CRON_SCHEDULE="0 * * * *" pnpm --filter backend check-missing-trades:cron
 */

import 'dotenv/config';
import cron from 'node-cron';
import { Connection, PublicKey } from '@solana/web3.js';
import { prisma } from '../lib/prisma.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { WalletProcessingQueueRepository } from '../repositories/wallet-processing-queue.repository.js';
import { NormalizedTradeRepository } from '../repositories/normalized-trade.repository.js';
import { SolanaCollectorService } from '../services/solana-collector.service.js';
import { LotMatchingService } from '../services/lot-matching.service.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';

const smartWalletRepo = new SmartWalletRepository();
const tradeRepo = new TradeRepository();
const tokenRepo = new TokenRepository();
const walletQueueRepo = new WalletProcessingQueueRepository();
const normalizedTradeRepo = new NormalizedTradeRepository();
const metricsHistoryRepo = new MetricsHistoryRepository();
const collectorService = new SolanaCollectorService(
  smartWalletRepo,
  tradeRepo,
  tokenRepo,
  walletQueueRepo,
  normalizedTradeRepo
);
const lotMatchingService = new LotMatchingService();
const metricsCalculator = new MetricsCalculatorService(
  smartWalletRepo,
  tradeRepo,
  metricsHistoryRepo
);

async function checkMissingTrades() {
  console.log(`\n⏰ [${new Date().toISOString()}] Starting missing trades check...`);

  // 1. Setup RPC connection
  const rpcUrl = 
    process.env.QUICKNODE_RPC_URL || 
    process.env.SOLANA_RPC_URL;
  
  if (!rpcUrl) {
    console.error('❌ No RPC URL configured (QUICKNODE_RPC_URL or SOLANA_RPC_URL)');
    return;
  }

  console.log(`📡 Connecting to RPC: ${rpcUrl.substring(0, 50)}...`);

  try {
    const connection = new Connection(rpcUrl, 'confirmed');

    // 2. Get all wallets
    const wallets = await prisma.smartWallet.findMany({
      select: {
        id: true,
        address: true,
      },
    });

    const walletList = wallets ?? [];
    
    // OPTIMALIZACE: Filtruj pouze aktivní wallets (měly trades v posledních 7 dnech)
    // Tím snížíme RPC volání pro neaktivní wallets
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentTrades = await prisma.trade.findMany({
      where: {
        timestamp: { gte: sevenDaysAgo },
      },
      select: { walletId: true },
      distinct: ['walletId'],
    });

    const activeWalletIds = new Set(recentTrades.map(t => t.walletId));
    const activeWallets = walletList.filter(w => activeWalletIds.has(w.id));
    
    console.log(`📊 Total wallets: ${walletList.length}, Active (7d): ${activeWallets.length}`);
    console.log(`   ⚡ Only checking active wallets to reduce RPC usage\n`);

    // 3. Calculate time range (last 1 hour)
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    const oneHourAgoSec = Math.floor(oneHourAgo / 1000);

    console.log(`📅 Checking transactions from last hour:`);
    console.log(`   From: ${new Date(oneHourAgo).toLocaleString()}`);
    console.log(`   To: ${new Date(now).toLocaleString()}\n`);

    let totalProcessed = 0;
    let totalSaved = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let totalAlreadyExists = 0;
    const walletsWithNewTrades = new Set<string>(); // Track wallets with new trades

    // 4. Process each active wallet
    for (const wallet of activeWallets) {
      try {
        console.log(`🔍 Checking wallet: ${wallet.address.substring(0, 8)}...`);

        const walletPubkey = new PublicKey(wallet.address);
        
        // OPTIMALIZACE: Použij menší limit pro snížení RPC spotřeby
        // Pro kontrolu za poslední hodinu stačí 100 signatures (většina wallets nemá tolik trades/hodinu)
        const signatures = await connection.getSignaturesForAddress(
          walletPubkey,
          {
            limit: 100, // Sníženo z 1000 na 100 - stačí pro kontrolu za poslední hodinu
          },
          'confirmed'
        );

        if (signatures.length === 0) {
          console.log(`   ✅ No transactions in last hour`);
          continue;
        }

        // Filter by time - only process transactions within last hour
        const relevantSigs = signatures.filter(sig => {
          if (!sig.blockTime) return false;
          const sigTime = sig.blockTime * 1000;
          return sigTime >= oneHourAgo && sigTime <= now;
        });

        console.log(`   📋 Found ${signatures.length} total signatures, ${relevantSigs.length} in last hour`);

        if (relevantSigs.length === 0) {
          continue;
        }

        // 5. Check which transactions are missing from DB
        let processed = 0;
        let saved = 0;
        let skipped = 0;
        let errors = 0;
        let alreadyExists = 0;

        for (const sigInfo of relevantSigs) {
          try {
            // Check if already exists in DB
            const existing = await tradeRepo.findBySignature(sigInfo.signature);
            if (existing) {
              alreadyExists++;
              continue;
            }

            // Fetch full transaction
            const tx = await connection.getTransaction(sigInfo.signature, {
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed',
            });

            if (!tx) {
              skipped++;
              continue;
            }

            // Convert to QuickNode format (compatible with processQuickNodeTransaction)
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

            processed++;
            if (result.saved) {
              saved++;
              walletsWithNewTrades.add(wallet.id); // Track wallet with new trades
              console.log(`   ✅ Saved missing trade: ${sigInfo.signature.substring(0, 16)}...`);
            } else {
              skipped++;
              if (result.reason) {
                console.log(`   ⏭️  Skipped: ${result.reason}`);
              }
            }

            // OPTIMALIZACE: Zvětšen delay pro snížení RPC spotřeby
            await new Promise(resolve => setTimeout(resolve, 200));

          } catch (error: any) {
            errors++;
            console.error(`   ❌ Error processing ${sigInfo.signature.substring(0, 16)}...: ${error.message}`);
            // Pokud je to rate limit error, počkej déle
            if (error.message?.includes('429') || error.message?.includes('rate limit')) {
              console.log(`   ⏳ Rate limit detected, waiting 2 seconds...`);
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }
        }

        console.log(`   📊 Results: ${saved} saved, ${alreadyExists} already exist, ${skipped} skipped, ${errors} errors\n`);

        totalProcessed += processed;
        totalSaved += saved;
        totalSkipped += skipped;
        totalErrors += errors;
        totalAlreadyExists += alreadyExists;

        // OPTIMALIZACE: Zvětšen delay mezi wallets pro snížení RPC spotřeby
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error: any) {
        console.error(`  ❌ Error checking wallet ${wallet.address}:`, error.message);
        totalErrors++;
      }
    }

    console.log(`\n✅ Missing trades check completed:`);
    console.log(`   Total processed: ${totalProcessed}`);
    console.log(`   Saved: ${totalSaved}`);
    console.log(`   Already exist: ${totalAlreadyExists}`);
    console.log(`   Skipped: ${totalSkipped}`);
    console.log(`   Errors: ${totalErrors}\n`);

    // 6. Recalculate closed lots for wallets with new trades
    if (walletsWithNewTrades.size > 0) {
      console.log(`\n🔄 Recalculating closed lots for ${walletsWithNewTrades.size} wallet(s) with new trades...\n`);
      
      let closedLotsProcessed = 0;
      let closedLotsErrors = 0;
      
      for (const walletId of walletsWithNewTrades) {
        try {
          const wallet = await smartWalletRepo.findById(walletId);
          if (!wallet) {
            console.warn(`⚠️  Wallet ${walletId} not found, skipping closed lots recalculation`);
            continue;
          }

          console.log(`   🔄 Processing closed lots for wallet: ${wallet.address.substring(0, 8)}...`);
          
          const trackingStartTime = wallet.createdAt ? new Date(wallet.createdAt) : undefined;
          const closedLots = await lotMatchingService.processTradesForWallet(
            walletId,
            undefined, // Process all tokens
            trackingStartTime
          );

          await lotMatchingService.saveClosedLots(closedLots);
          console.log(`   ✅ Created ${closedLots.length} closed lots`);
          
          // Also recalculate metrics to update PnL, win rate, score, etc.
          try {
            await metricsCalculator.calculateMetricsForWallet(walletId);
            console.log(`   ✅ Metrics recalculated`);
          } catch (metricsError: any) {
            console.warn(`   ⚠️  Metrics recalculation failed: ${metricsError.message}`);
          }
          
          closedLotsProcessed++;
        } catch (error: any) {
          console.error(`   ❌ Error processing closed lots for wallet ${walletId}:`, error.message);
          closedLotsErrors++;
        }
      }

      console.log(`\n✅ Closed lots recalculation completed:`);
      console.log(`   Processed: ${closedLotsProcessed}`);
      console.log(`   Errors: ${closedLotsErrors}\n`);
    } else {
      console.log(`\n⏭️  No new trades found, skipping closed lots recalculation\n`);
    }

  } catch (error: any) {
    console.error('❌ Error in missing trades check:', error);
  }
}

async function main() {
  // Default: každé 3 hodiny (0 */3 * * *) - optimalizace pro snížení RPC spotřeby
  const cronSchedule = process.env.CRON_SCHEDULE || '0 */3 * * *';

  console.log(`🚀 Starting missing trades check cron job`);
  console.log(`📅 Schedule: ${cronSchedule}`);
  console.log(`   (Default: every 3 hours. Set CRON_SCHEDULE env var to customize)`);
  console.log(`   ⚡ Optimized: Only checks active wallets (trades in last 7 days)`);

  // Spusť jednou hned při startu (pro testování)
  if (process.env.RUN_ON_START !== 'false') {
    await checkMissingTrades();
  }

  // Nastav cron job
  cron.schedule(cronSchedule, async () => {
    await checkMissingTrades();
  });

  // Keep process running
  process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down missing trades check cron...');
    process.exit(0);
  });

  console.log('✅ Missing trades check cron job is running. Press Ctrl+C to stop.');
}

main();
