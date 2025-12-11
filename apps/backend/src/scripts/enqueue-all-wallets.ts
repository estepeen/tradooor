/**
 * Script to enqueue all wallets with trades for metrics recalculation
 * 
 * Usage:
 *   pnpm --filter backend tsx src/scripts/enqueue-all-wallets.ts
 */

import 'dotenv/config';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { WalletProcessingQueueRepository } from '../repositories/wallet-processing-queue.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';

const walletRepo = new SmartWalletRepository();
const queueRepo = new WalletProcessingQueueRepository();
const tradeRepo = new TradeRepository();

async function main() {
  console.log('🚀 Enqueueing all wallets with trades for metrics recalculation...\n');

  try {
    // Fetch all wallets
    const allWallets = await walletRepo.findAll({ page: 1, pageSize: 10000 });
    const wallets = allWallets.wallets || [];
    
    console.log(`📊 Found ${wallets.length} wallets\n`);

    if (wallets.length === 0) {
      console.log('⚠️  No wallets found in database');
      process.exit(0);
    }

    let added = 0;
    let skipped = 0;
    let errors = 0;

    // Process wallets
    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i];
      
      try {
        // Check if wallet has trades
        const trades = await tradeRepo.findByWalletId(wallet.id, { page: 1, pageSize: 1 });
        if (trades.total === 0) {
          skipped++;
          continue;
        }

        // Add to queue
        await queueRepo.enqueue(wallet.id);
        added++;

        // Log progress every 10 wallets
        if (added % 10 === 0) {
          console.log(`📊 Progress: ${i + 1}/${wallets.length} wallets checked, ${added} enqueued, ${skipped} skipped, ${errors} errors`);
        }
      } catch (error: any) {
        errors++;
        console.error(`❌ Error enqueueing wallet ${wallet.id}:`, error?.message || error);
      }
    }

    // Final summary
    console.log('\n' + '='.repeat(60));
    console.log('✅ Enqueueing completed!');
    console.log('='.repeat(60));
    console.log(`Total wallets: ${wallets.length}`);
    console.log(`✅ Enqueued: ${added}`);
    console.log(`⏭️  Skipped (no trades): ${skipped}`);
    console.log(`❌ Errors: ${errors}`);
    console.log('='.repeat(60));
    console.log(`\n💡 Worker queue (tradooor-metrics-worker) will process these wallets automatically.\n`);

    process.exit(0);
  } catch (error: any) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

main();
