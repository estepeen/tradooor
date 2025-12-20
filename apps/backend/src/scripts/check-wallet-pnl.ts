/**
 * Check and fix PnL for a specific wallet
 */

import { prisma } from '../lib/prisma.js';
import { SolPriceService } from '../services/sol-price.service.js';
import { safeDecimalToNumber } from '../lib/prisma.js';
import { ClosedLotRepository } from '../repositories/closed-lot.repository.js';

async function checkWalletPnl(walletAddress: string) {
  console.log(`🔍 Checking PnL for wallet: ${walletAddress}\n`);

  // Find wallet by address
  const wallet = await prisma.smartWallet.findUnique({
    where: { address: walletAddress },
    select: {
      id: true,
      address: true,
      label: true,
      recentPnl30dUsd: true,
      recentPnl30dPercent: true,
    },
  });

  if (!wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }

  console.log(`✅ Found wallet: ${wallet.label || wallet.address}`);
  console.log(`   Current recentPnl30dUsd: ${wallet.recentPnl30dUsd?.toFixed(2) || 0} USD\n`);

  // Get all closed lots for this wallet
  const closedLotRepo = new ClosedLotRepository();
  const allLots = await closedLotRepo.findByWallet(wallet.id);

  console.log(`📦 Found ${allLots.length} closed lots\n`);

  // Filter lots from last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentLots = allLots.filter(lot => lot.exitTime >= thirtyDaysAgo);

  console.log(`📅 Closed lots from last 30 days: ${recentLots.length}\n`);

  // Calculate PnL from closed lots (sum of realizedPnlUsd)
  const totalPnlUsd = recentLots.reduce((sum, lot) => {
    const pnl = safeDecimalToNumber(lot.realizedPnlUsd || 0);
    return sum + pnl;
  }, 0);

  console.log(`💰 Calculated PnL from closed lots: ${totalPnlUsd.toFixed(2)} USD`);
  console.log(`   Current wallet PnL: ${wallet.recentPnl30dUsd?.toFixed(2) || 0} USD`);
  console.log(`   Difference: ${(totalPnlUsd - (wallet.recentPnl30dUsd || 0)).toFixed(2)} USD\n`);

  // Check for suspicious values
  const solPriceService = new SolPriceService();
  let currentSolPrice = 150;
  try {
    currentSolPrice = await solPriceService.getSolPriceUsd();
  } catch (error) {
    // Ignore
  }

  let suspiciousCount = 0;
  const suspiciousLots: Array<{ id: string; realizedPnl: number; realizedPnlUsd: number; expected: number }> = [];

  for (const lot of recentLots) {
    const realizedPnl = safeDecimalToNumber(lot.realizedPnl);
    const realizedPnlUsd = safeDecimalToNumber(lot.realizedPnlUsd || 0);
    const expected = realizedPnl * currentSolPrice;

    // Check if realizedPnlUsd is suspiciously high (more than 2x expected)
    if (Math.abs(realizedPnlUsd) > Math.abs(expected) * 2 && Math.abs(realizedPnl) > 0.0001) {
      suspiciousCount++;
      if (suspiciousLots.length < 10) {
        suspiciousLots.push({
          id: lot.id,
          realizedPnl,
          realizedPnlUsd,
          expected,
        });
      }
    }
  }

  if (suspiciousCount > 0) {
    console.log(`⚠️  Found ${suspiciousCount} suspicious lots (realizedPnlUsd > 2x expected)\n`);
    console.log('Sample suspicious lots:');
    for (const lot of suspiciousLots) {
      console.log(`   Lot ${lot.id.substring(0, 16)}...`);
      console.log(`     realizedPnl: ${lot.realizedPnl.toFixed(6)} SOL`);
      console.log(`     realizedPnlUsd: ${lot.realizedPnlUsd.toFixed(2)} USD`);
      console.log(`     expected: ${lot.expected.toFixed(2)} USD`);
      console.log(`     ratio: ${(lot.realizedPnlUsd / lot.expected).toFixed(2)}x\n`);
    }
  } else {
    console.log(`✅ No suspicious values found. PnL values look correct.\n`);
  }

  // Show top 10 lots by PnL
  const topLots = recentLots
    .sort((a, b) => safeDecimalToNumber(b.realizedPnlUsd || 0) - safeDecimalToNumber(a.realizedPnlUsd || 0))
    .slice(0, 10);

  console.log('📊 Top 10 lots by PnL (last 30 days):');
  for (const lot of topLots) {
    const pnl = safeDecimalToNumber(lot.realizedPnlUsd || 0);
    const pnlSol = safeDecimalToNumber(lot.realizedPnl);
    console.log(`   ${lot.id.substring(0, 16)}...: ${pnl.toFixed(2)} USD (${pnlSol.toFixed(6)} SOL)`);
  }
}

const walletAddress = process.argv[2];
if (!walletAddress) {
  console.error('Usage: tsx check-wallet-pnl.ts <WALLET_ADDRESS>');
  process.exit(1);
}

checkWalletPnl(walletAddress)
  .then(() => {
    console.log('\n✅ Done');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });

