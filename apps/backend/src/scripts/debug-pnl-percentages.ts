/**
 * Debug PnL percentages - check if they're calculated correctly
 * 
 * Usage: pnpm --filter backend debug:pnl-percentages <WALLET_ADDRESS>
 */

import { prisma } from '../lib/prisma.js';
import { ClosedLotRepository } from '../repositories/closed-lot.repository.js';
import { safeDecimalToNumber } from '../lib/prisma.js';

async function debugPnlPercentages(walletAddress: string) {
  console.log(`🔍 Debugging PnL percentages for wallet: ${walletAddress}\n`);

  // Find wallet by address
  const wallet = await prisma.smartWallet.findUnique({
    where: { address: walletAddress },
    select: {
      id: true,
      address: true,
      label: true,
      recentPnl30dUsd: true, // Contains SOL values now
      recentPnl30dPercent: true,
    },
  });

  if (!wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }

  console.log(`✅ Found wallet: ${wallet.label || wallet.address}`);
  console.log(`   Recent PnL (30d): ${wallet.recentPnl30dUsd?.toFixed(6) || 0} SOL`);
  console.log(`   Recent PnL % (30d): ${wallet.recentPnl30dPercent?.toFixed(2) || 0}%\n`);

  // Get all closed lots for this wallet
  const closedLotRepo = new ClosedLotRepository();
  const allLots = await closedLotRepo.findByWallet(wallet.id);

  console.log(`📦 Found ${allLots.length} closed lots total\n`);

  // Filter lots from last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentLots = allLots.filter(lot => lot.exitTime >= thirtyDaysAgo);

  console.log(`📅 Closed lots from last 30 days: ${recentLots.length}\n`);

  // Calculate PnL and percentages
  let totalPnl = 0;
  let totalCostBasis = 0;
  let totalProceeds = 0;
  const suspiciousLots: Array<{
    id: string;
    costBasis: number;
    proceeds: number;
    realizedPnl: number;
    realizedPnlPercent: number;
    calculatedPercent: number;
  }> = [];

  for (const lot of recentLots) {
    const costBasis = safeDecimalToNumber(lot.costBasis);
    const proceeds = safeDecimalToNumber(lot.proceeds);
    const realizedPnl = safeDecimalToNumber(lot.realizedPnl);
    const realizedPnlPercent = safeDecimalToNumber(lot.realizedPnlPercent || 0);
    
    // Calculate what the percentage should be
    const calculatedPercent = costBasis > 0 ? (realizedPnl / costBasis) * 100 : 0;
    
    totalPnl += realizedPnl;
    totalCostBasis += costBasis;
    totalProceeds += proceeds;
    
    // Check if percentage is suspicious
    // Suspicious = percentage differs from calculated by more than 0.1% OR
    // if PnL is large (>10 SOL) but percentage is small (<50%)
    const percentDiff = Math.abs(realizedPnlPercent - calculatedPercent);
    const isSuspicious = percentDiff > 0.1 || (Math.abs(realizedPnl) > 10 && Math.abs(realizedPnlPercent) < 50);
    
    if (isSuspicious && suspiciousLots.length < 20) {
      suspiciousLots.push({
        id: lot.id,
        costBasis,
        proceeds,
        realizedPnl,
        realizedPnlPercent,
        calculatedPercent,
      });
    }
  }

  // Calculate overall percentage
  const overallPercent = totalCostBasis > 0 ? (totalPnl / totalCostBasis) * 100 : 0;

  console.log(`💰 Summary (last 30 days):`);
  console.log(`   Total PnL: ${totalPnl.toFixed(6)} SOL`);
  console.log(`   Total Cost Basis: ${totalCostBasis.toFixed(6)} SOL`);
  console.log(`   Total Proceeds: ${totalProceeds.toFixed(6)} SOL`);
  console.log(`   Overall ROI %: ${overallPercent.toFixed(2)}%`);
  console.log(`   Wallet PnL %: ${wallet.recentPnl30dPercent?.toFixed(2) || 0}%`);
  console.log(`   Difference: ${(overallPercent - (wallet.recentPnl30dPercent || 0)).toFixed(2)}%\n`);

  if (suspiciousLots.length > 0) {
    console.log(`⚠️  Found ${suspiciousLots.length} suspicious lots:\n`);
    for (const lot of suspiciousLots) {
      console.log(`   Lot ${lot.id.substring(0, 16)}...`);
      console.log(`     Cost Basis: ${lot.costBasis.toFixed(6)} SOL`);
      console.log(`     Proceeds: ${lot.proceeds.toFixed(6)} SOL`);
      console.log(`     Realized PnL: ${lot.realizedPnl.toFixed(6)} SOL`);
      console.log(`     Stored %: ${lot.realizedPnlPercent.toFixed(2)}%`);
      console.log(`     Calculated %: ${lot.calculatedPercent.toFixed(2)}%`);
      console.log(`     Difference: ${(lot.realizedPnlPercent - lot.calculatedPercent).toFixed(2)}%`);
      
      // Check if percentage makes sense
      if (Math.abs(lot.realizedPnl) > 10 && Math.abs(lot.realizedPnlPercent) < 50) {
        const expectedPercent = (lot.realizedPnl / lot.costBasis) * 100;
        console.log(`     ⚠️  WARNING: Large PnL (${lot.realizedPnl.toFixed(2)} SOL) but small % (${lot.realizedPnlPercent.toFixed(2)}%)`);
        console.log(`        Expected %: ${expectedPercent.toFixed(2)}%`);
        console.log(`        This suggests costBasis might be too high: ${lot.costBasis.toFixed(2)} SOL`);
      }
      console.log('');
    }
  } else {
    console.log(`✅ No suspicious lots found. Percentages look correct.\n`);
  }

  // Show top 10 lots by PnL
  const topLots = recentLots
    .sort((a, b) => safeDecimalToNumber(b.realizedPnl || 0) - safeDecimalToNumber(a.realizedPnl || 0))
    .slice(0, 10);

  console.log('📊 Top 10 lots by PnL (last 30 days):');
  for (const lot of topLots) {
    const pnl = safeDecimalToNumber(lot.realizedPnl || 0);
    const pnlPercent = safeDecimalToNumber(lot.realizedPnlPercent || 0);
    const costBasis = safeDecimalToNumber(lot.costBasis);
    const calculatedPercent = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
    console.log(`   ${lot.id.substring(0, 16)}...: ${pnl.toFixed(6)} SOL (${pnlPercent.toFixed(2)}%, cost: ${costBasis.toFixed(6)} SOL, calc: ${calculatedPercent.toFixed(2)}%)`);
  }
}

const walletAddress = process.argv[2];
if (!walletAddress) {
  console.error('Usage: tsx debug-pnl-percentages.ts <WALLET_ADDRESS>');
  process.exit(1);
}

debugPnlPercentages(walletAddress)
  .then(() => {
    console.log('\n✅ Done');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });

