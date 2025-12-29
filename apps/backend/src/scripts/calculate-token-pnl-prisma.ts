import 'dotenv/config';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { ClosedLotRepository } from '../repositories/closed-lot.repository.js';
import { prisma } from '../lib/prisma.js';

const smartWalletRepo = new SmartWalletRepository();
const tokenRepo = new TokenRepository();
const closedLotRepo = new ClosedLotRepository();

async function calculateTokenPnL(walletAddress: string, tokenSymbol: string) {
  console.log(`\n🔍 Calculating PnL for wallet ${walletAddress} and token $${tokenSymbol}\n`);

  // 1. Find wallet
  const wallet = await smartWalletRepo.findByAddress(walletAddress);
  if (!wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }
  console.log(`✅ Found wallet: ${wallet.label || wallet.address} (ID: ${wallet.id})\n`);

  // 2. Find token by symbol (case-insensitive)
  const tokens = await prisma.token.findMany({
    where: {
      symbol: {
        equals: tokenSymbol,
        mode: 'insensitive',
      },
    },
    take: 10,
  });

  if (!tokens || tokens.length === 0) {
    console.error(`❌ Token not found: $${tokenSymbol}`);
    process.exit(1);
  }

  if (tokens.length > 1) {
    console.log(`⚠️  Found ${tokens.length} tokens with symbol $${tokenSymbol}, using first one`);
  }

  const token = tokens[0];
  console.log(`✅ Found token: $${token.symbol || 'N/A'} (${token.name || 'N/A'}) - ${token.mintAddress}\n`);

  // 3. Get all closed lots for this wallet and token
  const closedLots = await closedLotRepo.findByWalletId(wallet.id, token.id);
  
  console.log(`📊 Found ${closedLots.length} closed lots for $${tokenSymbol}\n`);

  if (closedLots.length === 0) {
    console.log(`\n📊 No closed lots found for $${tokenSymbol} in wallet ${walletAddress}`);
    console.log(`\n✅ Calculation complete!\n`);
    process.exit(0);
  }

  // 4. Calculate totals from closed lots
  let totalRealizedPnl = 0;
  let totalCostBasis = 0;
  let totalProceeds = 0;
  let totalSize = 0;

  console.log(`📈 Closed Lots Details:\n`);
  
  for (let i = 0; i < closedLots.length; i++) {
    const lot = closedLots[i];
    const cost = lot.costBasis;
    const proceeds = lot.proceeds;
    const pnl = lot.realizedPnl;
    const size = lot.size;
    
    totalCostBasis += cost;
    totalProceeds += proceeds;
    totalRealizedPnl += pnl;
    totalSize += size;

    const entryTime = new Date(lot.entryTime).toLocaleString();
    const exitTime = new Date(lot.exitTime).toLocaleString();
    const holdTimeHours = (lot.holdTimeMinutes / 60).toFixed(2);

    console.log(`   Lot ${i + 1}:`);
    console.log(`     Size: ${size.toFixed(6)} tokens`);
    console.log(`     Entry: $${lot.entryPrice.toFixed(6)} @ ${entryTime}`);
    console.log(`     Exit: $${lot.exitPrice.toFixed(6)} @ ${exitTime}`);
    console.log(`     Hold Time: ${holdTimeHours} hours (${lot.holdTimeMinutes.toFixed(0)} min)`);
    console.log(`     Cost Basis: ${cost.toFixed(6)} SOL`);
    console.log(`     Proceeds: ${proceeds.toFixed(6)} SOL`);
    console.log(`     Realized PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL (${lot.realizedPnlPercent >= 0 ? '+' : ''}${lot.realizedPnlPercent.toFixed(2)}%)`);
    if (lot.sellTradeId) {
      console.log(`     Sell Trade ID: ${lot.sellTradeId}`);
    }
    if (lot.sequenceNumber !== null) {
      console.log(`     Sequence Number: ${lot.sequenceNumber}`);
    }
    console.log('');
  }

  const realizedPnlPercent = totalCostBasis > 0 ? (totalRealizedPnl / totalCostBasis) * 100 : 0;

  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`💵 Realized PnL Summary for $${tokenSymbol}`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`Total Closed Lots: ${closedLots.length}`);
  console.log(`Total Size: ${totalSize.toFixed(6)} tokens`);
  console.log(`Total Cost Basis: ${totalCostBasis.toFixed(6)} SOL`);
  console.log(`Total Proceeds: ${totalProceeds.toFixed(6)} SOL`);
  console.log(`Total Realized PnL: ${totalRealizedPnl >= 0 ? '+' : ''}${totalRealizedPnl.toFixed(6)} SOL`);
  console.log(`Realized PnL %: ${realizedPnlPercent >= 0 ? '+' : ''}${realizedPnlPercent.toFixed(2)}%`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  // 5. Check how closed positions are grouped in portfolio endpoint
  // This is the same logic as in smart-wallets.ts portfolio endpoint
  console.log(`🔍 Checking closed positions grouping (as in portfolio endpoint):\n`);
  
  // Group by tokenId (same as portfolio endpoint)
  const lotsByToken = new Map<string, typeof closedLots>();
  for (const lot of closedLots) {
    const tokenId = lot.tokenId;
    if (!lotsByToken.has(tokenId)) {
      lotsByToken.set(tokenId, []);
    }
    lotsByToken.get(tokenId)!.push(lot);
  }

  for (const [tokenId, lotsForToken] of lotsByToken.entries()) {
    const totalRealizedPnlGrouped = lotsForToken.reduce((sum: number, lot: any) => {
      const pnl = lot.realizedPnl !== null && lot.realizedPnl !== undefined ? lot.realizedPnl : 0;
      return sum + pnl;
    }, 0);
    
    const totalCostBaseGrouped = lotsForToken.reduce((sum: number, lot: any) => sum + (lot.costBasis || 0), 0);
    const totalProceedsBaseGrouped = lotsForToken.reduce((sum: number, lot: any) => sum + (lot.proceeds || 0), 0);
    const effectiveCostBase = totalCostBaseGrouped > 0 ? totalCostBaseGrouped : (totalProceedsBaseGrouped - totalRealizedPnlGrouped);
    const realizedPnlPercentGrouped = effectiveCostBase > 0 ? (totalRealizedPnlGrouped / effectiveCostBase) * 100 : 0;

    console.log(`   Grouped Closed Position (as in portfolio):`);
    console.log(`     Token ID: ${tokenId}`);
    console.log(`     Number of lots: ${lotsForToken.length}`);
    console.log(`     Total Realized PnL: ${totalRealizedPnlGrouped >= 0 ? '+' : ''}${totalRealizedPnlGrouped.toFixed(6)} SOL`);
    console.log(`     Total Cost Base: ${totalCostBaseGrouped.toFixed(6)} SOL`);
    console.log(`     Total Proceeds Base: ${totalProceedsBaseGrouped.toFixed(6)} SOL`);
    console.log(`     Realized PnL %: ${realizedPnlPercentGrouped >= 0 ? '+' : ''}${realizedPnlPercentGrouped.toFixed(2)}%`);
    console.log('');
  }

  // 6. Verify calculation: proceeds - costBasis should equal realizedPnl
  console.log(`🔍 Verification:\n`);
  let hasDiscrepancy = false;
  for (const lot of closedLots) {
    const calculatedPnl = lot.proceeds - lot.costBasis;
    const storedPnl = lot.realizedPnl;
    const diff = Math.abs(calculatedPnl - storedPnl);
    
    if (diff > 0.000001) { // Allow for floating point precision
      console.log(`   ⚠️  DISCREPANCY in Lot ${lot.id}:`);
      console.log(`      Stored PnL: ${storedPnl.toFixed(6)} SOL`);
      console.log(`      Calculated PnL (proceeds - costBasis): ${calculatedPnl.toFixed(6)} SOL`);
      console.log(`      Difference: ${diff.toFixed(6)} SOL`);
      hasDiscrepancy = true;
    }
  }
  
  if (!hasDiscrepancy) {
    console.log(`   ✅ All lots: stored PnL matches calculated PnL (proceeds - costBasis)\n`);
  }

  console.log(`✅ Calculation complete!\n`);
}

// Run script
const walletAddress = process.argv[2];
const tokenSymbol = process.argv[3];

if (!walletAddress || !tokenSymbol) {
  console.error('Usage: pnpm calculate-token-pnl-prisma <walletAddress> <tokenSymbol>');
  console.error('Example: pnpm calculate-token-pnl-prisma 8rvAsDKeAcEjEkiZMug9k8v1y8mW6gQQiMobd89Uy7qR YINYANG');
  process.exit(1);
}

calculateTokenPnL(walletAddress, tokenSymbol).catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});

