/**
 * Debug script to check ClosedLot records for a specific wallet
 * Usage: pnpm tsx src/scripts/debug-closed-lots.ts <walletAddress>
 */

import { supabase, TABLES } from '../lib/supabase.js';
import { LotMatchingService } from '../services/lot-matching.service.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';

async function debugClosedLots(walletAddress: string) {
  console.log(`\n🔍 Debugging ClosedLot records for wallet: ${walletAddress}\n`);

  const smartWalletRepo = new SmartWalletRepository();
  const tradeRepo = new TradeRepository();
  const lotMatchingService = new LotMatchingService();

  // 1. Find wallet
  let wallet = await smartWalletRepo.findByAddress(walletAddress);
  if (!wallet) {
    wallet = await smartWalletRepo.findById(walletAddress);
  }
  if (!wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }

  console.log(`✅ Found wallet: ${wallet.label || wallet.address} (ID: ${wallet.id})\n`);

  // 2. Get all trades for this wallet
  const allTrades = await tradeRepo.findAllForMetrics(wallet.id);
  console.log(`📊 Total trades: ${allTrades?.length || 0}`);

  // Group trades by token
  const tradesByToken = new Map<string, any[]>();
  for (const trade of allTrades || []) {
    const tokenId = (trade as any).tokenId;
    if (!tradesByToken.has(tokenId)) {
      tradesByToken.set(tokenId, []);
    }
    tradesByToken.get(tokenId)!.push(trade);
  }

  console.log(`📦 Unique tokens: ${tradesByToken.size}\n`);

  // 3. Get existing ClosedLot records from database
  const { data: existingClosedLots, error: closedLotsError } = await supabase
    .from('ClosedLot')
    .select('*')
    .eq('walletId', wallet.id)
    .order('exitTime', { ascending: false });

  if (closedLotsError) {
    console.error(`❌ Error fetching ClosedLots:`, closedLotsError);
  } else {
    console.log(`📋 Existing ClosedLot records in DB: ${existingClosedLots?.length || 0}`);
  }

  // Group ClosedLots by token
  const closedLotsByToken = new Map<string, any[]>();
  for (const lot of existingClosedLots || []) {
    const tokenId = lot.tokenId;
    if (!closedLotsByToken.has(tokenId)) {
      closedLotsByToken.set(tokenId, []);
    }
    closedLotsByToken.get(tokenId)!.push(lot);
  }

  // 4. Check for tokens with SELL trades but no ClosedLot records
  console.log(`\n🔍 Checking for missing ClosedLot records...\n`);
  
  let missingCount = 0;
  for (const [tokenId, trades] of tradesByToken.entries()) {
    const sellTrades = trades.filter(t => {
      const side = (t.side || '').toLowerCase();
      return side === 'sell';
    });
    const buyTrades = trades.filter(t => {
      const side = (t.side || '').toLowerCase();
      return side === 'buy' || side === 'add';
    });

    const closedLotsForToken = closedLotsByToken.get(tokenId) || [];
    
    if (sellTrades.length > 0 && closedLotsForToken.length === 0) {
      console.log(`⚠️  Token ${tokenId}:`);
      console.log(`   - SELL trades: ${sellTrades.length}`);
      console.log(`   - BUY trades: ${buyTrades.length}`);
      console.log(`   - ClosedLot records: 0 (MISSING!)`);
      missingCount++;
    } else if (sellTrades.length > closedLotsForToken.length) {
      console.log(`⚠️  Token ${tokenId}:`);
      console.log(`   - SELL trades: ${sellTrades.length}`);
      console.log(`   - BUY trades: ${buyTrades.length}`);
      console.log(`   - ClosedLot records: ${closedLotsForToken.length} (expected at least ${sellTrades.length})`);
      missingCount++;
    }
  }

  if (missingCount === 0) {
    console.log(`✅ All tokens with SELL trades have ClosedLot records\n`);
  } else {
    console.log(`\n❌ Found ${missingCount} tokens with missing or incomplete ClosedLot records\n`);
  }

  // 5. Recalculate closed lots for this wallet
  console.log(`🔄 Recalculating closed lots...\n`);
  try {
    const recalculatedClosedLots = await lotMatchingService.processTradesForWallet(wallet.id);
    console.log(`✅ Recalculated ${recalculatedClosedLots.length} ClosedLot records\n`);

    // Group by token
    const recalculatedByToken = new Map<string, any[]>();
    for (const lot of recalculatedClosedLots) {
      if (!recalculatedByToken.has(lot.tokenId)) {
        recalculatedByToken.set(lot.tokenId, []);
      }
      recalculatedByToken.get(lot.tokenId)!.push(lot);
    }

    console.log(`📊 Recalculated ClosedLots by token:`);
    for (const [tokenId, lots] of recalculatedByToken.entries()) {
      const tokenTrades = tradesByToken.get(tokenId) || [];
      const sellTrades = tokenTrades.filter(t => {
        const side = (t.side || '').toLowerCase();
        return side === 'sell';
      });
      console.log(`   - Token ${tokenId}: ${lots.length} ClosedLots (${sellTrades.length} SELL trades)`);
    }

    // 6. Save recalculated closed lots
    console.log(`\n💾 Saving recalculated closed lots to database...`);
    await lotMatchingService.saveClosedLots(recalculatedClosedLots);
    console.log(`✅ Saved ${recalculatedClosedLots.length} ClosedLot records to database\n`);

  } catch (error: any) {
    console.error(`❌ Error recalculating closed lots:`, error.message);
    console.error(error);
  }

  // 7. Get token info for tokens with trades
  console.log(`\n📦 Token details:`);
  const uniqueTokenIds = Array.from(tradesByToken.keys());
  const { data: tokens } = await supabase
    .from(TABLES.TOKEN)
    .select('*')
    .in('id', uniqueTokenIds);

  const tokenMap = new Map<string, any>();
  (tokens || []).forEach(token => {
    tokenMap.set(token.id, token);
  });

  for (const [tokenId, trades] of tradesByToken.entries()) {
    const token = tokenMap.get(tokenId);
    const sellTrades = trades.filter(t => {
      const side = (t.side || '').toLowerCase();
      return side === 'sell';
    });
    const closedLotsForToken = closedLotsByToken.get(tokenId) || [];
    
    console.log(`\n   Token: ${token?.symbol || token?.name || tokenId}`);
    console.log(`   - Total trades: ${trades.length}`);
    console.log(`   - SELL trades: ${sellTrades.length}`);
    console.log(`   - ClosedLot records: ${closedLotsForToken.length}`);
    
    if (sellTrades.length > 0 && closedLotsForToken.length === 0) {
      console.log(`   ⚠️  WARNING: Has SELL trades but no ClosedLot records!`);
    }
  }

  console.log(`\n✅ Debug complete!\n`);
}

// Get wallet address from command line
const walletAddress = process.argv[2];
if (!walletAddress) {
  console.error('Usage: pnpm tsx src/scripts/debug-closed-lots.ts <walletAddress>');
  process.exit(1);
}

debugClosedLots(walletAddress).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
