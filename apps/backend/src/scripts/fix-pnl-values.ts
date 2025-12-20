/**
 * Fix PnL values in ClosedLot table
 * 
 * Problem: realizedPnlUsd may have been calculated incorrectly if proceeds was in USD
 * instead of SOL, causing double multiplication by SOL price.
 * 
 * Solution: Recalculate realizedPnlUsd = realizedPnl * SOL_price_at_exitTime
 */

import { prisma } from '../lib/prisma.js';
import { SolPriceService } from '../services/sol-price.service.js';
import { safeDecimalToNumber } from '../lib/prisma.js';

async function fixPnlValues() {
  console.log('🔍 Checking PnL values in ClosedLot table...\n');

  const solPriceService = new SolPriceService();
  let currentSolPrice = 150;
  try {
    currentSolPrice = await solPriceService.getSolPriceUsd();
    console.log(`💰 Current SOL price: $${currentSolPrice.toFixed(2)}\n`);
  } catch (error) {
    console.warn('⚠️  Failed to fetch SOL price, using fallback $150');
  }

  // Get all closed lots with suspiciously high realizedPnlUsd
  // Suspicious = realizedPnlUsd > realizedPnl * currentSolPrice * 1.5
  // (allowing 50% margin for SOL price changes)
  const allLots = await prisma.closedLot.findMany({
    select: {
      id: true,
      walletId: true,
      tokenId: true,
      realizedPnl: true,
      realizedPnlUsd: true,
      exitTime: true,
      costBasis: true,
      proceeds: true,
    },
    orderBy: { exitTime: 'desc' },
  });

  console.log(`Found ${allLots.length} closed lots total\n`);

  let suspiciousCount = 0;
  let fixedCount = 0;
  let checkedCount = 0;

  for (const lot of allLots) {
    checkedCount++;
    const realizedPnl = safeDecimalToNumber(lot.realizedPnl);
    const realizedPnlUsd = safeDecimalToNumber(lot.realizedPnlUsd || 0);
    const costBasis = safeDecimalToNumber(lot.costBasis);
    const proceeds = safeDecimalToNumber(lot.proceeds);

    // Skip if realizedPnl is 0 or very small
    if (Math.abs(realizedPnl) < 0.0001) {
      continue;
    }

    // Calculate expected realizedPnlUsd = realizedPnl * SOL_price
    // Use current SOL price as approximation (ideally we'd use historical price)
    const expectedRealizedPnlUsd = realizedPnl * currentSolPrice;
    
    // Check if realizedPnlUsd is suspiciously high (more than 2x expected)
    // This suggests double multiplication by SOL price
    if (Math.abs(realizedPnlUsd) > Math.abs(expectedRealizedPnlUsd) * 2) {
      suspiciousCount++;
      
      // Recalculate: realizedPnlUsd = realizedPnl * SOL_price
      const correctRealizedPnlUsd = realizedPnl * currentSolPrice;
      
      if (suspiciousCount <= 10) {
        console.log(`🔧 Fixing lot ${lot.id.substring(0, 16)}...`);
        console.log(`   realizedPnl: ${realizedPnl.toFixed(6)} SOL`);
        console.log(`   realizedPnlUsd (current): ${realizedPnlUsd.toFixed(2)} USD`);
        console.log(`   realizedPnlUsd (correct): ${correctRealizedPnlUsd.toFixed(2)} USD`);
        console.log(`   Ratio: ${(realizedPnlUsd / expectedRealizedPnlUsd).toFixed(2)}x\n`);
      }

      // Update the lot
      await prisma.closedLot.update({
        where: { id: lot.id },
        data: {
          realizedPnlUsd: correctRealizedPnlUsd.toString(),
        },
      });

      fixedCount++;
    }
  }

  console.log(`\n✅ Checked ${checkedCount} lots`);
  console.log(`   Found ${suspiciousCount} suspicious lots`);
  console.log(`   Fixed ${fixedCount} lots`);

  if (fixedCount > 0) {
    console.log('\n⚠️  IMPORTANT: After fixing, you need to:');
    console.log('   1. Recalculate metrics for all wallets:');
    console.log('      pnpm --filter backend metrics:cron');
    console.log('   2. Or recalculate specific wallet:');
    console.log('      pnpm --filter backend recalculate:wallet-closed-positions <WALLET_ID>');
  } else {
    console.log('\n✅ No suspicious values found. PnL values look correct.');
  }
}

// Run the fix
fixPnlValues()
  .then(() => {
    console.log('\n✅ Done');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });

