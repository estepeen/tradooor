/**
 * Debug script to compare PnL calculation between homepage/stats and trader detail page
 * 
 * Usage: pnpm --filter backend debug:pnl-diff <wallet-address>
 */

import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { ClosedLotRepository } from '../repositories/closed-lot.repository.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';
import { supabase, TABLES } from '../lib/supabase.js';

const walletAddress = process.argv[2];

if (!walletAddress) {
  console.error('❌ Usage: pnpm --filter backend debug:pnl-diff <wallet-address>');
  process.exit(1);
}

async function main() {
  console.log(`🔍 Debugging PnL difference for wallet: ${walletAddress}\n`);

  const smartWalletRepo = new SmartWalletRepository();
  const closedLotRepo = new ClosedLotRepository();
  const metricsCalculator = new MetricsCalculatorService();

  // 1. Find wallet
  const wallet = await smartWalletRepo.findByAddress(walletAddress);
  if (!wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }

  console.log(`✅ Wallet found: ${wallet.label || wallet.address}`);
  console.log(`   ID: ${wallet.id}\n`);

  // 2. Get rolling stats (homepage/stats calculation)
  console.log('📊 [HOME PAGE / STATS] Rolling stats calculation:');
  const rollingStats = await metricsCalculator['computeRollingStatsAndScores'](wallet.id);
  const rolling30d = rollingStats.rolling['30d'];
  const homepagePnl = rolling30d?.realizedPnlUsd ?? 0;
  console.log(`   realizedPnlUsd (30d): ${homepagePnl.toFixed(2)} USD`);
  console.log(`   numClosedTrades (30d): ${rolling30d?.numClosedTrades ?? 0}`);
  console.log(`   winRate (30d): ${((rolling30d?.winRate ?? 0) * 100).toFixed(2)}%\n`);

  // 3. Get closed lots for 30d
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const closedLots30d = await closedLotRepo.findByWallet(wallet.id, { fromDate: thirtyDaysAgo });
  console.log(`📦 Closed lots (30d): ${closedLots30d.length}`);
  console.log(`   Total realizedPnlUsd from lots: ${closedLots30d.reduce((sum, lot) => sum + (lot.realizedPnlUsd ?? 0), 0).toFixed(2)} USD\n`);

  // 4. Get portfolio endpoint calculation (detail page)
  console.log('📊 [DETAIL PAGE] Portfolio endpoint calculation:');
  
  // Simulate portfolio endpoint logic
  const { data: trades } = await supabase
    .from(TABLES.TRADE)
    .select('*')
    .eq('walletId', wallet.id)
    .order('timestamp', { ascending: true });

  if (!trades || trades.length === 0) {
    console.log('   No trades found');
    return;
  }

  // Build positions (same logic as portfolio endpoint)
  const positionMap = new Map<string, any>();
  for (const trade of trades) {
    const tokenId = trade.tokenId;
    const amount = Math.abs(Number(trade.amountToken || 0));
    const amountBase = Math.abs(Number(trade.amountBase || 0));
    const tradeTimestamp = new Date(trade.timestamp);

    if (!positionMap.has(tokenId)) {
      positionMap.set(tokenId, {
        tokenId,
        totalBought: 0,
        totalSold: 0,
        balance: 0,
        totalCostBase: 0,
        totalProceedsBase: 0,
        buyCount: 0,
        sellCount: 0,
        removeCount: 0,
        firstBuyTimestamp: null,
        lastSellTimestamp: null,
      });
    }

    const position = positionMap.get(tokenId)!;

    if (trade.side === 'buy' || trade.side === 'add') {
      position.totalBought += amount;
      position.balance += amount;
      position.totalCostBase += amountBase;
      position.buyCount++;
      if (!position.firstBuyTimestamp || tradeTimestamp < position.firstBuyTimestamp) {
        position.firstBuyTimestamp = tradeTimestamp;
      }
    } else if (trade.side === 'sell' || trade.side === 'remove') {
      position.totalSold += amount;
      position.balance -= amount;
      position.totalProceedsBase += amountBase;
      if (trade.side === 'sell') {
        position.sellCount++;
        if (!position.lastSellTimestamp || tradeTimestamp > position.lastSellTimestamp) {
          position.lastSellTimestamp = tradeTimestamp;
        }
      } else {
        position.removeCount++;
      }
    }
  }

  // Filter closed positions (same logic as portfolio endpoint)
  const closedPositions = Array.from(positionMap.values())
    .filter(p => {
      const normalizedBalance = p.balance < 0 && Math.abs(p.balance) < 0.0001 ? 0 : p.balance;
      return normalizedBalance <= 0 && p.sellCount > 0 && p.firstBuyTimestamp && p.lastSellTimestamp;
    });

  // Get closed lots for each closed position
  const recentClosedPositions30d = closedPositions.filter(p => {
    if (!p.lastSellTimestamp) return false;
    const sellDate = new Date(p.lastSellTimestamp);
    return sellDate >= thirtyDaysAgo && sellDate <= new Date();
  });

  console.log(`   Closed positions (30d): ${recentClosedPositions30d.length}`);

  // Calculate PnL from closed lots (same as portfolio endpoint)
  let detailPnl = 0;
  for (const position of recentClosedPositions30d) {
    const closedLotsForToken = closedLots30d.filter(lot => lot.tokenId === position.tokenId);
    const totalRealizedPnlUsd = closedLotsForToken.reduce((sum, lot) => {
      if (lot.realizedPnlUsd !== null && lot.realizedPnlUsd !== undefined) {
        return sum + Number(lot.realizedPnlUsd);
      }
      return sum;
    }, 0);
    detailPnl += totalRealizedPnlUsd;
    
    console.log(`   - Token ${position.tokenId}: ${closedLotsForToken.length} lots, PnL: ${totalRealizedPnlUsd.toFixed(2)} USD`);
  }

  console.log(`   Total realizedPnlUsd (30d): ${detailPnl.toFixed(2)} USD\n`);

  // 5. Compare
  const diff = Math.abs(homepagePnl - detailPnl);
  const diffPercent = homepagePnl !== 0 ? (diff / Math.abs(homepagePnl)) * 100 : 0;
  
  console.log('🔍 COMPARISON:');
  console.log(`   Homepage/Stats PnL: ${homepagePnl.toFixed(2)} USD`);
  console.log(`   Detail Page PnL:    ${detailPnl.toFixed(2)} USD`);
  console.log(`   Difference:         ${diff.toFixed(2)} USD (${diffPercent.toFixed(2)}%)`);
  
  if (diff > 0.01) {
    console.log(`\n⚠️  WARNING: PnL values differ by more than $0.01!`);
    
    // Debug: Show which lots are included in each calculation
    console.log('\n📋 Debug: Closed lots breakdown:');
    for (const lot of closedLots30d) {
      const exitDate = new Date(lot.exitTime);
      const isIn30d = exitDate >= thirtyDaysAgo;
      console.log(`   - Lot ${lot.id.substring(0, 16)}...: tokenId=${lot.tokenId}, exitTime=${lot.exitTime}, realizedPnlUsd=${lot.realizedPnlUsd?.toFixed(2) ?? 'null'}, in30d=${isIn30d}`);
    }
    
    // Debug: Show which positions are included in portfolio calculation
    console.log('\n📋 Debug: Closed positions breakdown:');
    for (const pos of recentClosedPositions30d) {
      const sellDate = new Date(pos.lastSellTimestamp!);
      const isIn30d = sellDate >= thirtyDaysAgo;
      const lotsForToken = closedLots30d.filter(lot => lot.tokenId === pos.tokenId);
      console.log(`   - Position tokenId=${pos.tokenId}: lastSell=${pos.lastSellTimestamp}, sellCount=${pos.sellCount}, balance=${pos.balance}, lots=${lotsForToken.length}, in30d=${isIn30d}`);
    }
  } else {
    console.log(`\n✅ PnL values match!`);
  }
}

main().catch(console.error);

