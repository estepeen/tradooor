import { PrismaClient } from '@prisma/client';
import { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

interface Trade {
  id: string;
  side: 'buy' | 'sell' | 'add' | 'remove';
  amountToken: string;
  amountBase: string;
  priceBasePerToken: string;
  timestamp: string;
  tokenId: string;
  token?: {
    symbol?: string;
    name?: string;
  };
}

async function calculateTokenPnL(walletAddress: string, tokenSymbol: string) {
  console.log(`\n🔍 Calculating PnL for wallet ${walletAddress} and token $${tokenSymbol}\n`);

  // 1. Find wallet
  const { data: wallet, error: walletError } = await supabase
    .from('SmartWallet')
    .select('id, address, label')
    .eq('address', walletAddress)
    .single();

  if (walletError || !wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }

  console.log(`✅ Found wallet: ${wallet.label || wallet.address} (ID: ${wallet.id})\n`);

  // 2. Find token by symbol
  const { data: tokens, error: tokenError } = await supabase
    .from('Token')
    .select('id, symbol, name, mintAddress')
    .ilike('symbol', tokenSymbol)
    .limit(1);

  if (tokenError || !tokens || tokens.length === 0) {
    console.error(`❌ Token not found: $${tokenSymbol}`);
    process.exit(1);
  }

  const token = tokens[0];
  console.log(`✅ Found token: $${token.symbol} (${token.name || 'N/A'})`);
  console.log(`   Token ID: ${token.id}`);
  console.log(`   Mint Address: ${token.mintAddress}\n`);

  // 3. Get all trades for this wallet and token
  const { data: trades, error: tradesError } = await supabase
    .from('Trade')
    .select(`
      id,
      side,
      amountToken,
      amountBase,
      priceBasePerToken,
      timestamp,
      tokenId,
      token:Token (
        symbol,
        name
      )
    `)
    .eq('walletId', wallet.id)
    .eq('tokenId', token.id)
    .order('timestamp', { ascending: true });

  if (tradesError) {
    console.error(`❌ Error fetching trades:`, tradesError);
    process.exit(1);
  }

  if (!trades || trades.length === 0) {
    console.log(`⚠️  No trades found for this wallet and token\n`);
    process.exit(0);
  }

  console.log(`📊 Found ${trades.length} trades\n`);

  // 4. Get closed lots for this wallet and token
  const { data: closedLots, error: lotsError } = await supabase
    .from('ClosedLot')
    .select('*')
    .eq('walletId', wallet.id)
    .eq('tokenId', token.id)
    .order('exitTime', { ascending: true });

  if (lotsError) {
    console.error(`❌ Error fetching closed lots:`, lotsError);
  }

  console.log(`📦 Closed Lots: ${closedLots?.length || 0}\n`);

  // 5. Calculate PnL from closed lots
  if (closedLots && closedLots.length > 0) {
    console.log('💰 PnL from Closed Lots (precomputed):');
    console.log('----------------------------------------');
    
    let totalRealizedPnl = 0;
    let totalRealizedPnlUsd = 0;
    let totalCostBasis = 0;
    let totalProceeds = 0;

    closedLots.forEach((lot: any, index: number) => {
      const realizedPnl = parseFloat(lot.realizedPnl || '0');
      const realizedPnlUsd = parseFloat(lot.realizedPnlUsd || '0');
      const costBasis = parseFloat(lot.costBasis || '0');
      const proceeds = parseFloat(lot.proceeds || '0');

      totalRealizedPnl += realizedPnl;
      totalRealizedPnlUsd += realizedPnlUsd;
      totalCostBasis += costBasis;
      totalProceeds += proceeds;

      const exitDate = new Date(lot.exitTime).toLocaleString();
      console.log(`\nLot ${index + 1}:`);
      console.log(`  Exit Date: ${exitDate}`);
      console.log(`  Amount: ${parseFloat(lot.amount || '0').toFixed(2)} ${token.symbol}`);
      console.log(`  Cost Basis: ${costBasis.toFixed(6)} SOL`);
      console.log(`  Proceeds: ${proceeds.toFixed(6)} SOL`);
      console.log(`  Realized PnL: ${realizedPnl.toFixed(6)} SOL (${realizedPnlUsd.toFixed(2)} USD)`);
      console.log(`  ROI: ${parseFloat(lot.realizedPnlPercent || '0').toFixed(2)}%`);
    });

    console.log('\n----------------------------------------');
    console.log('📊 SUMMARY:');
    console.log('----------------------------------------');
    console.log(`Total Closed Lots: ${closedLots.length}`);
    console.log(`Total Cost Basis: ${totalCostBasis.toFixed(6)} SOL`);
    console.log(`Total Proceeds: ${totalProceeds.toFixed(6)} SOL`);
    console.log(`Total Realized PnL: ${totalRealizedPnl.toFixed(6)} SOL`);
    console.log(`Total Realized PnL (USD): ${totalRealizedPnlUsd.toFixed(2)} USD`);
    if (totalCostBasis > 0) {
      const totalROI = ((totalProceeds - totalCostBasis) / totalCostBasis) * 100;
      console.log(`Total ROI: ${totalROI.toFixed(2)}%`);
    }
  } else {
    console.log('⚠️  No closed lots found - calculating from raw trades\n');
    
    // Calculate from raw trades
    let balance = 0;
    let totalCost = 0;
    let totalProceeds = 0;
    const buyTrades: Trade[] = [];
    const sellTrades: Trade[] = [];

    trades.forEach((trade: any) => {
      const amount = parseFloat(trade.amountToken);
      const value = parseFloat(trade.amountBase);
      const price = parseFloat(trade.priceBasePerToken);

      if (trade.side === 'buy' || trade.side === 'add') {
        balance += amount;
        totalCost += value;
        buyTrades.push(trade);
      } else if (trade.side === 'sell' || trade.side === 'remove') {
        balance -= amount;
        totalProceeds += value;
        sellTrades.push(trade);
      }
    });

    console.log('📊 Trade Analysis:');
    console.log('----------------------------------------');
    console.log(`Total Trades: ${trades.length}`);
    console.log(`  Buy/Add: ${buyTrades.length}`);
    console.log(`  Sell/Remove: ${sellTrades.length}`);
    console.log(`Current Balance: ${balance.toFixed(2)} ${token.symbol}`);
    console.log(`Total Cost: ${totalCost.toFixed(6)} SOL`);
    console.log(`Total Proceeds: ${totalProceeds.toFixed(6)} SOL`);
    
    if (balance <= 0 && sellTrades.length > 0) {
      const realizedPnl = totalProceeds - totalCost;
      const roi = totalCost > 0 ? (realizedPnl / totalCost) * 100 : 0;
      console.log(`\n💰 Realized PnL: ${realizedPnl.toFixed(6)} SOL`);
      console.log(`   ROI: ${roi.toFixed(2)}%`);
    } else {
      console.log(`\n⚠️  Position is still open (balance: ${balance.toFixed(2)})`);
    }
  }

  console.log('\n');
}

// Main
const walletAddress = process.argv[2];
const tokenSymbol = process.argv[3];

if (!walletAddress || !tokenSymbol) {
  console.error('Usage: tsx calculate-token-pnl.ts <walletAddress> <tokenSymbol>');
  console.error('Example: tsx calculate-token-pnl.ts 4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk RAIN');
  process.exit(1);
}

calculateTokenPnL(walletAddress, tokenSymbol)
  .then(() => {
    prisma.$disconnect();
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Error:', error);
    prisma.$disconnect();
    process.exit(1);
  });

