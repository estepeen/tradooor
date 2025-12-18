import 'dotenv/config';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { prisma } from '../lib/prisma.js';
import { Prisma } from '@prisma/client';

const smartWalletRepo = new SmartWalletRepository();

async function calculateWalletPnL(walletAddress: string, daysBack: number = 7) {
  console.log(`\n💰 Calculating PnL for wallet: ${walletAddress}`);
  console.log(`   Time range: last ${daysBack} days\n`);

  // 1. Find wallet
  const wallet = await smartWalletRepo.findByAddress(walletAddress);
  if (!wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }
  console.log(`✅ Found wallet: ${wallet.label || wallet.address} (ID: ${wallet.id})\n`);

  // 2. Calculate date range
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - daysBack);

  console.log(`📅 Time range:`);
  console.log(`   From: ${startDate.toISOString()}`);
  console.log(`   To: ${now.toISOString()}\n`);

  // 3. Query ClosedLot for PnL calculation
  const closedLots = await prisma.closedLot.findMany({
    where: {
      walletId: wallet.id,
      exitTime: {
        gte: startDate,
        lte: now,
      },
      // Only count lots where we know the cost (not pre-history)
      costKnown: true,
    },
    select: {
      id: true,
      tokenId: true,
      exitTime: true,
      realizedPnlUsd: true,
      realizedPnl: true,
      realizedPnlPercent: true,
      size: true,
      entryPrice: true,
      exitPrice: true,
      costBasis: true,
      proceeds: true,
      token: {
        select: {
          symbol: true,
          name: true,
        },
      },
    },
    orderBy: {
      exitTime: 'desc',
    },
  });

  console.log(`📊 Found ${closedLots.length} closed lots in the last ${daysBack} days\n`);

  // 4. Calculate totals
  let totalPnlUsd = 0;
  let totalCostBasis = 0;
  let totalProceeds = 0;
  let winCount = 0;
  let lossCount = 0;
  let breakevenCount = 0;

  const lotsByToken = new Map<string, any[]>();

  for (const lot of closedLots) {
    const pnlUsd = lot.realizedPnlUsd ? Number(lot.realizedPnlUsd) : 0;
    const costBasis = Number(lot.costBasis || 0);
    const proceeds = Number(lot.proceeds || 0);

    totalPnlUsd += pnlUsd;
    totalCostBasis += costBasis;
    totalProceeds += proceeds;

    if (pnlUsd > 0.01) {
      winCount++;
    } else if (pnlUsd < -0.01) {
      lossCount++;
    } else {
      breakevenCount++;
    }

    // Group by token
    if (!lotsByToken.has(lot.tokenId)) {
      lotsByToken.set(lot.tokenId, []);
    }
    lotsByToken.get(lot.tokenId)!.push(lot);
  }

  const totalPnlPercent = totalCostBasis > 0 ? (totalPnlUsd / totalCostBasis) * 100 : 0;
  const winRate = closedLots.length > 0 ? (winCount / closedLots.length) * 100 : 0;

  // 5. Display results
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`📈 PnL Summary (Last ${daysBack} days)`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`Wallet: ${wallet.label || wallet.address}`);
  console.log(`Period: ${startDate.toLocaleDateString()} - ${now.toLocaleDateString()}`);
  console.log(``);
  console.log(`Total Closed Lots: ${closedLots.length}`);
  console.log(`Wins: ${winCount} | Losses: ${lossCount} | Breakeven: ${breakevenCount}`);
  console.log(`Win Rate: ${winRate.toFixed(2)}%`);
  console.log(``);
  console.log(`💰 Total PnL (USD): $${totalPnlUsd.toFixed(2)}`);
  console.log(`   Cost Basis: $${totalCostBasis.toFixed(2)}`);
  console.log(`   Proceeds: $${totalProceeds.toFixed(2)}`);
  console.log(`   PnL %: ${totalPnlPercent.toFixed(2)}%`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  // 6. Show breakdown by token (top 10)
  if (lotsByToken.size > 0) {
    console.log(`📊 Breakdown by Token (Top 10):\n`);
    const tokenStats = Array.from(lotsByToken.entries()).map(([tokenId, lots]) => {
      const tokenPnlUsd = lots.reduce((sum, lot) => sum + (lot.realizedPnlUsd ? Number(lot.realizedPnlUsd) : 0), 0);
      const tokenCostBasis = lots.reduce((sum, lot) => sum + Number(lot.costBasis || 0), 0);
      const tokenPnlPercent = tokenCostBasis > 0 ? (tokenPnlUsd / tokenCostBasis) * 100 : 0;
      return {
        tokenId,
        token: lots[0].token,
        count: lots.length,
        pnlUsd: tokenPnlUsd,
        pnlPercent: tokenPnlPercent,
      };
    });

    // Sort by absolute PnL
    tokenStats.sort((a, b) => Math.abs(b.pnlUsd) - Math.abs(a.pnlUsd));

    // Show top 10
    tokenStats.slice(0, 10).forEach((stat, index) => {
      const symbol = stat.token?.symbol || stat.tokenId.substring(0, 8);
      const sign = stat.pnlUsd >= 0 ? '+' : '';
      console.log(`  ${index + 1}. ${symbol.padEnd(12)} | ${stat.count} lots | ${sign}$${stat.pnlUsd.toFixed(2).padStart(10)} | ${sign}${stat.pnlPercent.toFixed(2)}%`);
    });
    console.log(``);
  }

  // 7. Show recent closed lots (last 10)
  if (closedLots.length > 0) {
    console.log(`📋 Recent Closed Lots (Last 10):\n`);
    closedLots.slice(0, 10).forEach((lot, index) => {
      const symbol = lot.token?.symbol || lot.tokenId.substring(0, 8);
      const pnlUsd = lot.realizedPnlUsd ? Number(lot.realizedPnlUsd) : 0;
      const pnlPercent = lot.realizedPnlPercent ? Number(lot.realizedPnlPercent) : 0;
      const sign = pnlUsd >= 0 ? '+' : '';
      const exitTime = new Date(lot.exitTime).toLocaleString();
      console.log(`  ${index + 1}. ${symbol.padEnd(12)} | ${exitTime} | ${sign}$${pnlUsd.toFixed(2).padStart(10)} | ${sign}${pnlPercent.toFixed(2)}%`);
    });
    console.log(``);
  }

  // 8. Compare with cached value from SmartWallet
  console.log(`🔍 Comparison with cached values:`);
  console.log(`   Cached recentPnl30dUsd: $${wallet.recentPnl30dUsd?.toFixed(2) || '0.00'}`);
  console.log(`   Calculated PnL (${daysBack}d): $${totalPnlUsd.toFixed(2)}`);
  if (daysBack === 7) {
    console.log(`   ⚠️  Note: Cached value is for 30 days, this is for 7 days`);
  }
  console.log(``);
}

// Run script
const walletAddress = process.argv[2];
const daysBack = parseInt(process.argv[3]) || 7;

if (!walletAddress) {
  console.error('Usage: pnpm calculate-wallet-pnl <walletAddress> [daysBack]');
  console.error('Example: pnpm calculate-wallet-pnl 2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f 7');
  process.exit(1);
}

calculateWalletPnL(walletAddress, daysBack).catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

