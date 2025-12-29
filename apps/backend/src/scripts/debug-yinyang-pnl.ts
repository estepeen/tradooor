/**
 * Debug PnL calculation for YINYANG token
 * 
 * Analyzes closed lots to find why PnL is -14.48 SOL instead of -4 SOL
 */

import 'dotenv/config';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { ClosedLotRepository } from '../repositories/closed-lot.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { prisma } from '../lib/prisma.js';

const walletAddress = '8rvAsDKeAcEjEkiZMug9k8v1y8mW6gQQiMobd89Uy7qR';
const tokenSymbol = 'YINYANG';

async function debugYinyangPnL() {
  console.log(`\n🔍 Debugging PnL for $${tokenSymbol} in wallet ${walletAddress}\n`);

  const smartWalletRepo = new SmartWalletRepository();
  const closedLotRepo = new ClosedLotRepository();
  const tradeRepo = new TradeRepository();

  // 1. Find wallet
  const wallet = await smartWalletRepo.findByAddress(walletAddress);
  if (!wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }
  console.log(`✅ Found wallet: ${wallet.label || wallet.address} (ID: ${wallet.id})\n`);

  // 2. Find token
  const token = await prisma.token.findFirst({
    where: {
      symbol: {
        equals: tokenSymbol,
        mode: 'insensitive',
      },
    },
  });

  if (!token) {
    console.error(`❌ Token not found: $${tokenSymbol}`);
    process.exit(1);
  }
  console.log(`✅ Found token: $${token.symbol} (ID: ${token.id})\n`);

  // 3. Get all trades for this wallet and token
  const allTrades = await tradeRepo.findByWalletId(wallet.id, {
    page: 1,
    pageSize: 10000,
  });
  
  const trades = allTrades.trades.filter(t => t.tokenId === token.id);
  const buyTrades = trades.filter(t => t.side === 'buy' || t.side === 'add');
  const sellTrades = trades.filter(t => t.side === 'sell' || t.side === 'remove');

  console.log(`📊 Trades:`);
  console.log(`   - Total: ${trades.length}`);
  console.log(`   - BUY: ${buyTrades.length}`);
  console.log(`   - SELL: ${sellTrades.length}\n`);

  // Show trades
  console.log(`📋 BUY Trades:`);
  buyTrades.forEach((trade, idx) => {
    const amount = Number(trade.amountToken || 0);
    const amountBase = Number(trade.amountBase || 0);
    const price = Number(trade.priceBasePerToken || 0);
    const timestamp = new Date(trade.timestamp).toLocaleString();
    console.log(`   ${idx + 1}. ${amount.toFixed(2)} tokens @ ${price.toFixed(6)} = ${amountBase.toFixed(6)} SOL (${timestamp})`);
  });

  console.log(`\n📋 SELL Trades:`);
  sellTrades.forEach((trade, idx) => {
    const amount = Number(trade.amountToken || 0);
    const amountBase = Number(trade.amountBase || 0);
    const price = Number(trade.priceBasePerToken || 0);
    const timestamp = new Date(trade.timestamp).toLocaleString();
    console.log(`   ${idx + 1}. ${amount.toFixed(2)} tokens @ ${price.toFixed(6)} = ${amountBase.toFixed(6)} SOL (${timestamp})`);
  });

  // Calculate expected PnL from trades
  const totalBought = buyTrades.reduce((sum, t) => sum + Number(t.amountBase || 0), 0);
  const totalSold = sellTrades.reduce((sum, t) => sum + Number(t.amountBase || 0), 0);
  const expectedPnl = totalSold - totalBought;

  console.log(`\n💰 Expected PnL (from trades):`);
  console.log(`   - Total Bought: ${totalBought.toFixed(6)} SOL`);
  console.log(`   - Total Sold: ${totalSold.toFixed(6)} SOL`);
  console.log(`   - Expected PnL: ${expectedPnl >= 0 ? '+' : ''}${expectedPnl.toFixed(6)} SOL\n`);

  // 4. Get all closed lots
  const closedLots = await closedLotRepo.findByWalletId(wallet.id, token.id);

  console.log(`📈 Closed Lots: ${closedLots.length}\n`);

  if (closedLots.length === 0) {
    console.log(`⚠️  No closed lots found!`);
    process.exit(0);
  }

  // Show closed lots
  let totalCostBasis = 0;
  let totalProceeds = 0;
  let totalRealizedPnl = 0;

  console.log(`📋 Closed Lots Details:\n`);
  for (let i = 0; i < closedLots.length; i++) {
    const lot = closedLots[i];
    const cost = lot.costBasis;
    const proceeds = lot.proceeds;
    const pnl = lot.realizedPnl;
    
    totalCostBasis += cost;
    totalProceeds += proceeds;
    totalRealizedPnl += pnl;

    const entryTime = new Date(lot.entryTime).toLocaleString();
    const exitTime = new Date(lot.exitTime).toLocaleString();
    const calculatedPnl = proceeds - cost;
    const pnlDiff = Math.abs(pnl - calculatedPnl);

    console.log(`   Lot ${i + 1}:`);
    console.log(`     ID: ${lot.id}`);
    console.log(`     Size: ${lot.size.toFixed(6)} tokens`);
    console.log(`     Entry: $${lot.entryPrice.toFixed(6)} @ ${entryTime}`);
    console.log(`     Exit: $${lot.exitPrice.toFixed(6)} @ ${exitTime}`);
    console.log(`     Cost Basis: ${cost.toFixed(6)} SOL`);
    console.log(`     Proceeds: ${proceeds.toFixed(6)} SOL`);
    console.log(`     Stored PnL: ${pnl.toFixed(6)} SOL`);
    console.log(`     Calculated PnL (proceeds - cost): ${calculatedPnl.toFixed(6)} SOL`);
    if (pnlDiff > 0.000001) {
      console.log(`     ⚠️  DISCREPANCY: ${pnlDiff.toFixed(6)} SOL`);
    }
    console.log(`     Buy Trade ID: ${lot.buyTradeId || 'N/A'}`);
    console.log(`     Sell Trade ID: ${lot.sellTradeId || 'N/A'}`);
    console.log(`     Sequence Number: ${lot.sequenceNumber ?? 'N/A'}`);
    console.log('');
  }

  const realizedPnlPercent = totalCostBasis > 0 ? (totalRealizedPnl / totalCostBasis) * 100 : 0;

  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`💵 Closed Lots Summary:`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`Total Closed Lots: ${closedLots.length}`);
  console.log(`Total Cost Basis: ${totalCostBasis.toFixed(6)} SOL`);
  console.log(`Total Proceeds: ${totalProceeds.toFixed(6)} SOL`);
  console.log(`Total Realized PnL: ${totalRealizedPnl >= 0 ? '+' : ''}${totalRealizedPnl.toFixed(6)} SOL`);
  console.log(`Realized PnL %: ${realizedPnlPercent >= 0 ? '+' : ''}${realizedPnlPercent.toFixed(2)}%`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  // Check for duplicates
  const lotIds = new Set<string>();
  const duplicateIds: string[] = [];
  for (const lot of closedLots) {
    if (lotIds.has(lot.id)) {
      duplicateIds.push(lot.id);
    }
    lotIds.add(lot.id);
  }

  if (duplicateIds.length > 0) {
    console.log(`⚠️  Found ${duplicateIds.length} duplicate lot IDs: ${duplicateIds.join(', ')}\n`);
  } else {
    console.log(`✅ No duplicate lot IDs found\n`);
  }

  // Check lot keys for duplicates
  const lotKeys = new Map<string, string[]>();
  for (const lot of closedLots) {
    const key = `${lot.tokenId}-${lot.entryTime}-${lot.exitTime}-${lot.size}`;
    if (!lotKeys.has(key)) {
      lotKeys.set(key, []);
    }
    lotKeys.get(key)!.push(lot.id);
  }

  const duplicateKeys: string[] = [];
  for (const [key, ids] of lotKeys.entries()) {
    if (ids.length > 1) {
      duplicateKeys.push(key);
      console.log(`⚠️  Duplicate lot key: ${key} (IDs: ${ids.join(', ')})`);
    }
  }

  if (duplicateKeys.length === 0) {
    console.log(`✅ No duplicate lot keys found\n`);
  }

  // Compare with expected
  const difference = totalRealizedPnl - expectedPnl;
  console.log(`🔍 Comparison:`);
  console.log(`   - Expected PnL (from trades): ${expectedPnl.toFixed(6)} SOL`);
  console.log(`   - Actual PnL (from closed lots): ${totalRealizedPnl.toFixed(6)} SOL`);
  console.log(`   - Difference: ${difference >= 0 ? '+' : ''}${difference.toFixed(6)} SOL`);
  if (Math.abs(difference) > 0.01) {
    console.log(`   ⚠️  SIGNIFICANT DIFFERENCE DETECTED!`);
  }

  console.log(`\n✅ Debug complete!\n`);
}

debugYinyangPnL().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});

