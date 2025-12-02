/**
 * Script to check trade value calculation for a specific transaction
 * Usage: pnpm check-trade-value <txSignature>
 */

import 'dotenv/config';
import { TradeRepository } from '../repositories/trade.repository.js';
import { supabase, TABLES } from '../lib/supabase.js';

const TX_SIGNATURE = process.argv[2];

if (!TX_SIGNATURE) {
  console.error('❌ Usage: pnpm check-trade-value <txSignature>');
  process.exit(1);
}

const tradeRepo = new TradeRepository();

async function checkTradeValue() {
  console.log(`🔍 Checking trade value for: ${TX_SIGNATURE}\n`);

  try {
    // Find trade by signature
    const trade = await tradeRepo.findBySignature(TX_SIGNATURE);
    
    if (!trade) {
      console.error(`❌ Trade not found: ${TX_SIGNATURE}`);
      process.exit(1);
    }

    console.log('📊 Trade details:');
    console.log(`   ID: ${trade.id}`);
    console.log(`   Wallet ID: ${trade.walletId}`);
    console.log(`   Token ID: ${trade.tokenId}`);
    console.log(`   Side: ${trade.side}`);
    console.log(`   Amount Token: ${trade.amountToken}`);
    console.log(`   Amount Base: ${trade.amountBase}`);
    console.log(`   Price Base Per Token: ${trade.priceBasePerToken}`);
    console.log(`   Value USD: ${trade.valueUsd || 'null'}`);
    console.log(`   Base Token (from meta): ${(trade.meta as any)?.baseToken || 'unknown'}`);
    console.log(`   Timestamp: ${trade.timestamp}`);
    console.log(`   DEX: ${trade.dex}`);
    console.log(`   Meta:`, JSON.stringify(trade.meta, null, 2));

    // Get token details
    const { data: token, error: tokenError } = await supabase
      .from(TABLES.TOKEN)
      .select('*')
      .eq('id', trade.tokenId)
      .single();

    if (tokenError) {
      console.warn(`⚠️  Failed to fetch token: ${tokenError.message}`);
    } else {
      console.log(`\n🪙 Token details:`);
      console.log(`   Symbol: ${token.symbol || 'N/A'}`);
      console.log(`   Name: ${token.name || 'N/A'}`);
      console.log(`   Mint Address: ${token.mintAddress}`);
      console.log(`   Decimals: ${token.decimals}`);
    }

    // Check if amountBase seems wrong
    const amountBase = Number(trade.amountBase);
    const baseToken = (trade.meta as any)?.baseToken || 'SOL';
    
    console.log(`\n🔍 Analysis:`);
    console.log(`   Amount Base: ${amountBase}`);
    console.log(`   Base Token: ${baseToken}`);
    
    // If amountBase is very large (> $100,000), it's likely wrong
    if (amountBase > 100000) {
      console.log(`   ⚠️  WARNING: amountBase is very large (${amountBase}), likely incorrect!`);
      console.log(`   This could be due to:`);
      console.log(`   1. Old trade with amountBase in SOL instead of USD`);
      console.log(`   2. Incorrect conversion for token-to-token swap`);
      console.log(`   3. Wrong decimals used in calculation`);
    } else if (amountBase > 10000) {
      console.log(`   ⚠️  amountBase is large (${amountBase}), but might be correct`);
    } else {
      console.log(`   ✅ amountBase seems reasonable`);
    }

    // Check if it's a token-to-token swap
    if (baseToken !== 'SOL' && baseToken !== 'USDC' && baseToken !== 'USDT' && baseToken !== 'WSOL') {
      console.log(`   ℹ️  This appears to be a token-to-token swap (base: ${baseToken})`);
      console.log(`   The amountBase should be in USD after conversion from the secondary token price.`);
    }

  } catch (error: any) {
    console.error('❌ Error checking trade:', error);
    process.exit(1);
  }
}

checkTradeValue()
  .then(() => {
    console.log('\n✅ Check completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Script failed:', error);
    process.exit(1);
  });

