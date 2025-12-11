/**
 * Worker to process trades and create closed lots using FIFO matching
 * 
 * This worker should be run:
 * - After initial trade collection
 * - Periodically to recalculate closed lots (e.g., when new trades are added)
 * - When trades are updated/corrected
 * 
 * Usage:
 *   pnpm --filter @solbot/backend process:closed-lots [WALLET_ID]
 *   (if WALLET_ID is not provided, processes all wallets)
 */

import 'dotenv/config';
import { LotMatchingService } from '../services/lot-matching.service.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { supabase, TABLES } from '../lib/supabase.js';

const lotMatchingService = new LotMatchingService();
const smartWalletRepo = new SmartWalletRepository();

async function processClosedLots(walletId?: string) {
  console.log('🔄 Starting closed lots processing...');

  try {
    let walletIds: string[] = [];

    if (walletId) {
      // Process specific wallet
      const wallet = await smartWalletRepo.findById(walletId);
      if (!wallet) {
        console.error(`❌ Wallet not found: ${walletId}`);
        return;
      }
      walletIds = [walletId];
      console.log(`📊 Processing wallet: ${wallet.address} (${wallet.label || 'no label'})`);
    } else {
      // Process all wallets
      const { data: wallets, error } = await supabase
        .from(TABLES.SMART_WALLET)
        .select('id, address, label');

      if (error) {
        throw new Error(`Failed to fetch wallets: ${error.message}`);
      }

      if (!wallets || wallets.length === 0) {
        console.log('⚠️  No wallets found');
        return;
      }

      walletIds = wallets.map(w => w.id);
      console.log(`📊 Processing ${walletIds.length} wallets...`);
    }

    let totalProcessed = 0;
    let totalErrors = 0;

    for (const wid of walletIds) {
      try {
        console.log(`\n🔄 Processing wallet ${wid}...`);

        // Get wallet to find tracking start time (createdAt)
        const wallet = await smartWalletRepo.findById(wid);
        if (!wallet) {
          console.warn(`⚠️  Wallet ${wid} not found, skipping...`);
          continue;
        }

        const trackingStartTime = wallet.createdAt ? new Date(wallet.createdAt) : undefined;

        // Process trades and create closed lots
        const closedLots = await lotMatchingService.processTradesForWallet(
          wid,
          undefined, // Process all tokens
          trackingStartTime
        );

        // Save closed lots to database
        await lotMatchingService.saveClosedLots(closedLots);

        console.log(`✅ Processed wallet ${wid}: ${closedLots.length} closed lots created`);
        totalProcessed++;

        // Count pre-history lots
        const preHistoryCount = closedLots.filter(l => l.isPreHistory).length;
        if (preHistoryCount > 0) {
          console.log(`   ⚠️  ${preHistoryCount} pre-history lots (cost unknown)`);
        }
      } catch (error: any) {
        console.error(`❌ Error processing wallet ${wid}:`, error.message);
        totalErrors++;
      }
    }

    console.log('\n✅ Closed lots processing complete!');
    console.log(`   Processed: ${totalProcessed}`);
    console.log(`   Errors: ${totalErrors}`);
  } catch (error: any) {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  }
}

// Get wallet ID from command line argument
const walletId = process.argv[2];

processClosedLots(walletId)
  .then(() => {
    console.log('✅ Done');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });

