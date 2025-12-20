/**
 * Debug PnL display - check what values are returned from API
 * 
 * Usage: pnpm --filter backend debug:pnl-display <WALLET_ADDRESS>
 */

import { prisma } from '../lib/prisma.js';
import { ClosedLotRepository } from '../repositories/closed-lot.repository.js';
import { safeDecimalToNumber } from '../lib/prisma.js';

async function debugPnlDisplay(walletAddress: string) {
  console.log(`🔍 Debugging PnL display for wallet: ${walletAddress}\n`);

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
  console.log(`   Database recentPnl30dUsd: ${wallet.recentPnl30dUsd?.toFixed(6) || 0} SOL`);
  console.log(`   Database recentPnl30dPercent: ${wallet.recentPnl30dPercent?.toFixed(2) || 0}%\n`);

  // Get all closed lots for this wallet
  const closedLotRepo = new ClosedLotRepository();
  const allLots = await closedLotRepo.findByWallet(wallet.id);

  console.log(`📦 Found ${allLots.length} closed lots total\n`);

  // Filter lots from last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentLots = allLots.filter(lot => lot.exitTime >= thirtyDaysAgo);

  console.log(`📅 Closed lots from last 30 days: ${recentLots.length}\n`);

  // Calculate PnL from closed lots (sum of realizedPnl)
  const totalPnl = recentLots.reduce((sum, lot) => {
    const pnl = safeDecimalToNumber(lot.realizedPnl || 0);
    return sum + pnl;
  }, 0);

  console.log(`💰 Calculated PnL from closed lots: ${totalPnl.toFixed(6)} SOL`);
  console.log(`   Database PnL: ${wallet.recentPnl30dUsd?.toFixed(6) || 0} SOL`);
  console.log(`   Difference: ${(totalPnl - (wallet.recentPnl30dUsd || 0)).toFixed(6)} SOL\n`);

  // Show sample lots
  console.log('📊 Sample closed lots (first 5):');
  for (const lot of recentLots.slice(0, 5)) {
    const pnl = safeDecimalToNumber(lot.realizedPnl || 0);
    const costBasis = safeDecimalToNumber(lot.costBasis);
    const proceeds = safeDecimalToNumber(lot.proceeds);
    const pnlPercent = safeDecimalToNumber(lot.realizedPnlPercent || 0);
    console.log(`   ${lot.id.substring(0, 16)}...`);
    console.log(`     realizedPnl: ${pnl.toFixed(6)} SOL`);
    console.log(`     costBasis: ${costBasis.toFixed(6)} SOL`);
    console.log(`     proceeds: ${proceeds.toFixed(6)} SOL`);
    console.log(`     realizedPnlPercent: ${pnlPercent.toFixed(2)}%`);
    console.log(`     exitTime: ${lot.exitTime?.toISOString()}\n`);
  }

  // Check for suspicious values
  const suspiciousLots = recentLots.filter(lot => {
    const pnl = safeDecimalToNumber(lot.realizedPnl || 0);
    const costBasis = safeDecimalToNumber(lot.costBasis);
    const pnlPercent = safeDecimalToNumber(lot.realizedPnlPercent || 0);
    const calculatedPercent = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
    
    // Suspicious if: large PnL but small %, or % differs significantly from calculated
    return (Math.abs(pnl) > 10 && Math.abs(pnlPercent) < 50) || 
           Math.abs(pnlPercent - calculatedPercent) > 1;
  });

  if (suspiciousLots.length > 0) {
    console.log(`⚠️  Found ${suspiciousLots.length} suspicious lots:\n`);
    for (const lot of suspiciousLots.slice(0, 5)) {
      const pnl = safeDecimalToNumber(lot.realizedPnl || 0);
      const costBasis = safeDecimalToNumber(lot.costBasis);
      const pnlPercent = safeDecimalToNumber(lot.realizedPnlPercent || 0);
      const calculatedPercent = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
      console.log(`   ${lot.id.substring(0, 16)}...`);
      console.log(`     PnL: ${pnl.toFixed(6)} SOL, Cost: ${costBasis.toFixed(6)} SOL`);
      console.log(`     Stored %: ${pnlPercent.toFixed(2)}%, Calculated %: ${calculatedPercent.toFixed(2)}%\n`);
    }
  }
}

const walletAddress = process.argv[2];
if (!walletAddress) {
  console.error('Usage: tsx debug-pnl-display.ts <WALLET_ADDRESS>');
  process.exit(1);
}

debugPnlDisplay(walletAddress)
  .then(() => {
    console.log('\n✅ Done');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });

