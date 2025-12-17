/**
 * Debug script to check trades and closed positions for a wallet
 * 
 * Usage:
 *   pnpm --filter backend debug:wallet-trades WALLET_ID_NEBO_ADDRESS
 */

import dotenv from 'dotenv';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { ClosedLotRepository } from '../repositories/closed-lot.repository.js';

dotenv.config();

async function main() {
  const identifier = process.argv[2];
  
  if (!identifier) {
    console.error('❌ Error: Wallet ID or address is required');
    console.log('\nUsage:');
    console.log('  pnpm --filter backend debug:wallet-trades WALLET_ID_NEBO_ADDRESS');
    process.exit(1);
  }

  const smartWalletRepo = new SmartWalletRepository();
  const tradeRepo = new TradeRepository();
  const closedLotRepo = new ClosedLotRepository();

  try {
    // Find wallet
    let wallet: any = await smartWalletRepo.findById(identifier);
    if (!wallet) {
      wallet = await smartWalletRepo.findByAddress(identifier);
    }
    if (!wallet) {
      console.error(`❌ Error: Wallet not found: ${identifier}`);
      process.exit(1);
    }

    console.log(`\n🔍 Debugging wallet: ${wallet.address}`);
    console.log(`   ID: ${wallet.id}`);
    console.log(`   Created: ${wallet.createdAt}`);
    console.log(`   Label: ${wallet.label || 'N/A'}\n`);

    // Get all trades
    const trades = await tradeRepo.findAllForMetrics(wallet.id);
    console.log(`\n📊 Trades: ${trades.length} total`);
    
    if (trades.length === 0) {
      console.log('   ⚠️  No trades found for this wallet');
      return;
    }

    // Group by side
    const buyTrades = trades.filter(t => t.side === 'buy');
    const sellTrades = trades.filter(t => t.side === 'sell');
    const voidTrades = trades.filter(t => t.side === 'void');
    
    console.log(`   Buy: ${buyTrades.length}`);
    console.log(`   Sell: ${sellTrades.length}`);
    console.log(`   Void: ${voidTrades.length}`);

    // Show recent trades
    console.log(`\n📝 Recent trades (last 10):`);
    const recentTrades = trades.slice(0, 10);
    for (const trade of recentTrades) {
      const date = new Date((trade as any).timestamp).toISOString();
      console.log(`   ${(trade as any).side.toUpperCase().padEnd(5)} | ${date} | Token: ${(trade as any).tokenId.substring(0, 16)}... | Amount: ${Number((trade as any).amountToken).toFixed(4)}`);
    }

    // Get closed lots
    const closedLots = await closedLotRepo.findByWallet(wallet.id);
    console.log(`\n📦 Closed Lots: ${closedLots.length} total`);
    
    if (closedLots.length === 0) {
      console.log('   ⚠️  No closed lots found');
      console.log('\n💡 Possible reasons:');
      console.log('   1. Only BUY trades (no SELL trades yet) - closed positions require BUY + SELL pair');
      console.log('   2. Closed lots not calculated yet - run: pnpm --filter backend recalculate:wallet-closed-positions ' + wallet.address);
      console.log('   3. All trades are VOID (liquidity operations)');
    } else {
      console.log(`\n📝 Recent closed lots (last 5):`);
      const recentLots = closedLots.slice(0, 5);
      for (const lot of recentLots) {
        const entryDate = new Date(lot.entryTime).toISOString();
        const exitDate = new Date(lot.exitTime).toISOString();
        const pnl = Number(lot.realizedPnl || 0);
        const pnlPercent = Number(lot.realizedPnlPercent || 0);
        console.log(`   Token: ${lot.tokenId.substring(0, 16)}... | Entry: ${entryDate} | Exit: ${exitDate} | PnL: ${pnl.toFixed(4)} (${pnlPercent.toFixed(2)}%)`);
      }
    }

    // Check if recalculation is needed
    if (trades.length > 0 && closedLots.length === 0 && sellTrades.length > 0) {
      console.log(`\n⚠️  WARNING: Wallet has ${sellTrades.length} SELL trades but 0 closed lots!`);
      console.log(`   This suggests closed lots were not calculated.`);
      console.log(`   Run: pnpm --filter backend recalculate:wallet-closed-positions ${wallet.address}`);
    }

    console.log('\n');
  } catch (error: any) {
    console.error('❌ Error:', error);
    console.error('Error message:', error?.message);
    console.error('Error stack:', error?.stack);
    process.exit(1);
  }
}

main();

