import 'dotenv/config';
import { LotMatchingService } from '../services/lot-matching.service.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { supabase, TABLES } from '../lib/supabase.js';

const lotMatchingService = new LotMatchingService();
const smartWalletRepo = new SmartWalletRepository();

async function recalculatePositions(walletAddress: string) {
  console.log(`\n🔄 Recalculating positions for wallet: ${walletAddress}\n`);

  // 1. Find wallet
  const wallet = await smartWalletRepo.findByAddress(walletAddress);
  if (!wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }
  console.log(`✅ Found wallet: ${wallet.label || wallet.address} (ID: ${wallet.id})\n`);

  // 2. Get tracking start time
  const trackingStartTime = wallet.createdAt ? new Date(wallet.createdAt) : undefined;

  // 3. Process trades and create closed lots
  console.log(`🔄 Processing trades and creating closed lots...\n`);
  const { closedLots, openPositions } = await lotMatchingService.processTradesForWallet(
    wallet.id,
    undefined, // Process all tokens
    trackingStartTime
  );

  console.log(`📊 Calculated ${closedLots.length} closed lots, ${openPositions.length} open positions\n`);

  // 4. Save closed lots to database (this will delete old ones and save new ones)
  console.log(`💾 Saving closed lots to database...\n`);
  await lotMatchingService.saveClosedLots(closedLots);
  if (openPositions.length > 0) {
    await lotMatchingService.saveOpenPositions(openPositions);
    console.log(`💾 Saved ${openPositions.length} open positions to database...\n`);
  } else {
    await lotMatchingService.deleteOpenPositionsForWallet(wallet.id);
    console.log(`💾 Deleted open positions (all closed)...\n`);
  }

  // 5. Show summary
  const byToken = new Map<string, number>();
  let totalPnl = 0;
  let preHistoryCount = 0;

  for (const lot of closedLots) {
    byToken.set(lot.tokenId, (byToken.get(lot.tokenId) || 0) + 1);
    totalPnl += lot.realizedPnl;
    if (lot.isPreHistory) preHistoryCount++;
  }

  console.log(`✅ Positions recalculated!\n`);
  console.log(`   Total closed lots: ${closedLots.length}`);
  console.log(`   Tokens with closed lots: ${byToken.size}`);
  console.log(`   Total realized PnL: ${totalPnl.toFixed(6)} SOL`);
  if (preHistoryCount > 0) {
    console.log(`   Pre-history lots: ${preHistoryCount} (cost unknown)`);
  }
  console.log(`\n`);
}

// Run script
const walletAddress = process.argv[2];

if (!walletAddress) {
  console.error('Usage: pnpm recalculate-positions <walletAddress>');
  console.error('Example: pnpm recalculate-positions 2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f');
  process.exit(1);
}

recalculatePositions(walletAddress).catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});

