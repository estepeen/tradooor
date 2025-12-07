import 'dotenv/config';
import { supabase, TABLES } from '../lib/supabase.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { TokenPriceService } from '../services/token-price.service.js';

const smartWalletRepo = new SmartWalletRepository();
const tokenRepo = new TokenRepository();
const tokenPriceService = new TokenPriceService();

async function calculateTokenPnL(walletAddress: string, tokenSymbol: string) {
  console.log(`\n🔍 Calculating PnL for wallet ${walletAddress} and token $${tokenSymbol}\n`);

  // 1. Find wallet
  const wallet = await smartWalletRepo.findByAddress(walletAddress);
  if (!wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }
  console.log(`✅ Found wallet: ${wallet.label || wallet.address} (ID: ${wallet.id})`);

  // 2. Find token by symbol
  const { data: tokens, error: tokenError } = await supabase
    .from(TABLES.TOKEN)
    .select('*')
    .ilike('symbol', tokenSymbol)
    .limit(10);

  if (tokenError || !tokens || tokens.length === 0) {
    console.error(`❌ Token not found: $${tokenSymbol}`);
    process.exit(1);
  }

  if (tokens.length > 1) {
    console.log(`⚠️  Found ${tokens.length} tokens with symbol $${tokenSymbol}, using first one`);
  }

  const token = tokens[0];
  console.log(`✅ Found token: $${token.symbol} (${token.name || 'N/A'}) - ${token.mintAddress}`);

  // 3. Get all trades for this wallet and token (exclude void)
  const { data: trades, error: tradesError } = await supabase
    .from(TABLES.TRADE)
    .select(`
      *,
      token:${TABLES.TOKEN}(*)
    `)
    .eq('walletId', wallet.id)
    .eq('tokenId', token.id)
    .in('side', ['buy', 'sell'])
    .order('timestamp', { ascending: true });

  if (tradesError) {
    console.error(`❌ Error fetching trades: ${tradesError.message}`);
    process.exit(1);
  }

  if (!trades || trades.length === 0) {
    console.log(`\n📊 No trades found for $${tokenSymbol} in wallet ${walletAddress}`);
    process.exit(0);
  }

  console.log(`\n📊 Found ${trades.length} trades (excluding void):`);

  // Count buy/sell trades
  const buyTrades = trades.filter(t => t.side === 'buy');
  const sellTrades = trades.filter(t => t.side === 'sell');
  console.log(`   - BUY trades: ${buyTrades.length}`);
  console.log(`   - SELL trades: ${sellTrades.length}`);

  // Calculate total invested and sold
  const totalInvested = buyTrades.reduce((sum, t) => {
    const valueUsd = Number(t.valueUsd || t.amountBase || 0);
    return sum + valueUsd;
  }, 0);

  const totalSold = sellTrades.reduce((sum, t) => {
    const valueUsd = Number(t.valueUsd || t.amountBase || 0);
    return sum + valueUsd;
  }, 0);

  console.log(`\n💰 Trade Summary:`);
  console.log(`   - Total Invested: $${totalInvested.toFixed(2)}`);
  console.log(`   - Total Sold: $${totalSold.toFixed(2)}`);

  // 4. Calculate realized PnL from closed lots
  const { data: closedLots, error: closedLotsError } = await supabase
    .from('ClosedLot')
    .select('*')
    .eq('walletId', wallet.id)
    .eq('tokenId', token.id)
    .order('exitTime', { ascending: false });
  
  let realizedPnl = 0;
  let realizedPnlPercent = 0;
  let totalCostBasis = 0;
  let totalProceeds = 0;

  if (closedLotsError) {
    console.warn(`⚠️  Error fetching closed lots: ${closedLotsError.message}`);
  }

  if (closedLots && closedLots.length > 0) {
    console.log(`\n📈 Closed Lots: ${closedLots.length}`);
    
    for (const lot of closedLots) {
      const cost = Number(lot.costBasis || 0);
      const proceeds = Number(lot.proceeds || 0);
      const pnl = Number(lot.realizedPnl || 0);
      
      totalCostBasis += cost;
      totalProceeds += proceeds;
      realizedPnl += pnl;

      console.log(`   - Lot: ${Number(lot.size).toFixed(6)} tokens, Entry: $${Number(lot.entryPrice).toFixed(6)}, Exit: $${Number(lot.exitPrice).toFixed(6)}`);
      console.log(`     Cost: $${cost.toFixed(2)}, Proceeds: $${proceeds.toFixed(2)}, PnL: $${pnl.toFixed(2)} (${Number(lot.realizedPnlPercent || 0).toFixed(2)}%)`);
    }

    if (totalCostBasis > 0) {
      realizedPnlPercent = (realizedPnl / totalCostBasis) * 100;
    }
  } else {
    // Fallback: calculate from trades if no closed lots
    realizedPnl = totalSold - totalInvested;
    if (totalInvested > 0) {
      realizedPnlPercent = (realizedPnl / totalInvested) * 100;
    }
    totalCostBasis = totalInvested;
    totalProceeds = totalSold;
  }

  console.log(`\n💵 Realized PnL:`);
  console.log(`   - Total Cost Basis: $${totalCostBasis.toFixed(2)}`);
  console.log(`   - Total Proceeds: $${totalProceeds.toFixed(2)}`);
  console.log(`   - Realized PnL: $${realizedPnl.toFixed(2)} (${realizedPnlPercent >= 0 ? '+' : ''}${realizedPnlPercent.toFixed(2)}%)`);

  // 5. Calculate unrealized PnL (if open position exists)
  const totalBought = buyTrades.reduce((sum, t) => sum + Number(t.amountToken || 0), 0);
  const totalSoldAmount = sellTrades.reduce((sum, t) => sum + Number(t.amountToken || 0), 0);
  const remainingBalance = totalBought - totalSoldAmount;

  if (remainingBalance > 0) {
    console.log(`\n📊 Open Position:`);
    console.log(`   - Remaining Balance: ${remainingBalance.toFixed(6)} tokens`);
    
    // Get current price
    let currentPrice = 0;
    try {
      const priceData = await tokenPriceService.getCurrentPrice(token.mintAddress);
      if (priceData && priceData.priceUsd) {
        currentPrice = priceData.priceUsd;
        console.log(`   - Current Price: $${currentPrice.toFixed(6)}`);
      }
    } catch (error) {
      console.warn(`   ⚠️  Could not fetch current price: ${(error as Error).message}`);
    }

    // Calculate average buy price
    const totalCostForRemaining = buyTrades.reduce((sum, t) => {
      const valueUsd = Number(t.valueUsd || t.amountBase || 0);
      return sum + valueUsd;
    }, 0);
    const averageBuyPrice = totalBought > 0 ? totalCostForRemaining / totalBought : 0;
    
    const currentValue = remainingBalance * currentPrice;
    const costBasis = remainingBalance * averageBuyPrice;
    const unrealizedPnl = currentValue - costBasis;
    const unrealizedPnlPercent = costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0;

    console.log(`   - Average Buy Price: $${averageBuyPrice.toFixed(6)}`);
    console.log(`   - Current Value: $${currentValue.toFixed(2)}`);
    console.log(`   - Cost Basis: $${costBasis.toFixed(2)}`);
    console.log(`   - Unrealized PnL: $${unrealizedPnl.toFixed(2)} (${unrealizedPnlPercent >= 0 ? '+' : ''}${unrealizedPnlPercent.toFixed(2)}%)`);

    const totalPnl = realizedPnl + unrealizedPnl;
    const totalPnlPercent = totalCostBasis + costBasis > 0 
      ? (totalPnl / (totalCostBasis + costBasis)) * 100 
      : 0;

    console.log(`\n🎯 Total PnL (Realized + Unrealized):`);
    console.log(`   - Total PnL: $${totalPnl.toFixed(2)} (${totalPnlPercent >= 0 ? '+' : ''}${totalPnlPercent.toFixed(2)}%)`);
  } else {
    console.log(`\n✅ No open position (all tokens sold)`);
    console.log(`\n🎯 Total PnL: $${realizedPnl.toFixed(2)} (${realizedPnlPercent >= 0 ? '+' : ''}${realizedPnlPercent.toFixed(2)}%)`);
  }

  // 6. Show trade details
  console.log(`\n📋 Trade Details:`);
  trades.forEach((trade, idx) => {
    const valueUsd = Number(trade.valueUsd || trade.amountBase || 0);
    const price = Number(trade.priceBasePerToken || 0);
    const amount = Number(trade.amountToken || 0);
    const timestamp = new Date(trade.timestamp).toLocaleString();
    
    console.log(`   ${idx + 1}. ${trade.side.toUpperCase()} - ${amount.toFixed(6)} tokens @ $${price.toFixed(6)} = $${valueUsd.toFixed(2)} (${timestamp})`);
  });

  console.log(`\n✅ Calculation complete!\n`);
}

// Run script
const walletAddress = process.argv[2];
const tokenSymbol = process.argv[3];

if (!walletAddress || !tokenSymbol) {
  console.error('Usage: pnpm calculate-token-pnl <walletAddress> <tokenSymbol>');
  console.error('Example: pnpm calculate-token-pnl 2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f TICK');
  process.exit(1);
}

calculateTokenPnL(walletAddress, tokenSymbol).catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});

