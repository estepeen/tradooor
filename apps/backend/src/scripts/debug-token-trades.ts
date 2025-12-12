/**
 * Debug script to check trades for a specific token in a wallet
 * Usage: pnpm tsx src/scripts/debug-token-trades.ts <walletAddress> <tokenSymbol>
 */

import { supabase, TABLES } from '../lib/supabase.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';

const STABLE_BASES = new Set(['SOL', 'WSOL', 'USDC', 'USDT']);

async function debugTokenTrades(walletAddress: string, tokenSymbol: string) {
  console.log(`\n🔍 Debugging trades for token: ${tokenSymbol} in wallet: ${walletAddress}\n`);

  const smartWalletRepo = new SmartWalletRepository();
  const tradeRepo = new TradeRepository();

  // 1. Find wallet
  let wallet = await smartWalletRepo.findByAddress(walletAddress);
  if (!wallet) {
    wallet = await smartWalletRepo.findById(walletAddress);
  }
  if (!wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }

  console.log(`✅ Found wallet: ${wallet.label || wallet.address} (ID: ${wallet.id})\n`);

  // 2. Find token by symbol (try multiple methods)
  let tokens: any[] = [];
  
  // Try exact match first
  const { data: exactTokens } = await supabase
    .from(TABLES.TOKEN)
    .select('*')
    .ilike('symbol', tokenSymbol);
  
  if (exactTokens && exactTokens.length > 0) {
    tokens = exactTokens;
  } else {
    // Try partial match
    const { data: partialTokens } = await supabase
      .from(TABLES.TOKEN)
      .select('*')
      .ilike('symbol', `%${tokenSymbol}%`);
    
    if (partialTokens && partialTokens.length > 0) {
      tokens = partialTokens;
    } else {
      // Try name match
      const { data: nameTokens } = await supabase
        .from(TABLES.TOKEN)
        .select('*')
        .ilike('name', `%${tokenSymbol}%`);
      
      if (nameTokens && nameTokens.length > 0) {
        tokens = nameTokens;
      }
    }
  }

  if (tokens.length === 0) {
    console.error(`❌ Token not found: ${tokenSymbol}`);
    console.log(`\n💡 Tip: Try searching for similar tokens or check the token symbol in the database.`);
    process.exit(1);
  }

  if (tokens.length > 1) {
    console.log(`⚠️  Found ${tokens.length} tokens matching "${tokenSymbol}":\n`);
    tokens.forEach((t, idx) => {
      console.log(`   ${idx + 1}. ${t.symbol || t.name} (ID: ${t.id}, Mint: ${t.mintAddress?.slice(0, 20)}...)`);
    });
    console.log(`\n   Using first match...\n`);
  }

  // Find exact match or first match
  const token = tokens.find(t => t.symbol?.toUpperCase() === tokenSymbol.toUpperCase()) || tokens[0];
  console.log(`✅ Found token: ${token.symbol || token.name} (ID: ${token.id}, Mint: ${token.mintAddress})\n`);

  // 3. Get all trades for this wallet and token
  const allTrades = await tradeRepo.findAllForMetrics(wallet.id);
  console.log(`📊 Total trades for wallet: ${allTrades?.length || 0}\n`);

  // Check all unique tokenIds in trades
  const uniqueTokenIds = new Set((allTrades || []).map(t => (t as any).tokenId));
  console.log(`📦 Unique tokenIds in trades: ${uniqueTokenIds.size}`);
  
  // Check if our tokenId is in the trades
  if (!uniqueTokenIds.has(token.id)) {
    console.log(`⚠️  Token ID ${token.id} not found in trades!`);
    console.log(`\n🔍 Searching for trades with similar token symbols...\n`);
    
    // Try to find trades by token symbol/name
    const { data: allTokens } = await supabase
      .from(TABLES.TOKEN)
      .select('*')
      .in('id', Array.from(uniqueTokenIds));
    
    if (allTokens && allTokens.length > 0) {
      const matchingTokens = allTokens.filter(t => 
        (t.symbol && t.symbol.toUpperCase().includes(tokenSymbol.toUpperCase())) ||
        (t.name && t.name.toUpperCase().includes(tokenSymbol.toUpperCase()))
      );
      
      if (matchingTokens.length > 0) {
        console.log(`✅ Found ${matchingTokens.length} matching token(s) in trades:\n`);
        for (const matchingToken of matchingTokens) {
          const matchingTrades = (allTrades || []).filter(t => (t as any).tokenId === matchingToken.id);
          console.log(`   - ${matchingToken.symbol || matchingToken.name} (ID: ${matchingToken.id}): ${matchingTrades.length} trades`);
        }
        console.log(`\n💡 Try using one of these token IDs or symbols.\n`);
      }
    }
    
    console.log(`❌ No trades found for token ID: ${token.id}`);
    process.exit(1);
  }

  const tokenTrades = (allTrades || []).filter(t => (t as any).tokenId === token.id);
  console.log(`📊 Total trades for token: ${tokenTrades.length}\n`);

  if (tokenTrades.length === 0) {
    console.log(`❌ No trades found for this token`);
    process.exit(1);
  }

  // 4. Analyze trades
  const buyTrades: any[] = [];
  const sellTrades: any[] = [];
  const voidTrades: any[] = [];
  const filteredTrades: any[] = [];

  for (const trade of tokenTrades) {
    const side = ((trade as any).side || '').toLowerCase();
    const baseToken = (((trade as any).meta?.baseToken || 'SOL') as string).toUpperCase();
    const amountBase = Number((trade as any).amountBase || 0);
    const price = Number((trade as any).priceBasePerToken || 0);
    const amountToken = Number((trade as any).amountToken || 0);
    const valueUsd = (trade as any).valueUsd || (trade as any).meta?.valueUsd || null;

    // Check why trade might be filtered
    let filterReason: string | null = null;
    
    if (side === 'void') {
      filterReason = 'void trade';
      voidTrades.push({ trade, reason: filterReason });
    } else if (!STABLE_BASES.has(baseToken)) {
      filterReason = `baseToken not in STABLE_BASES: ${baseToken}`;
      filteredTrades.push({ trade, reason: filterReason });
    } else if (side === 'buy' && amountBase < 0.0001) {
      filterReason = `BUY amountBase too small: ${amountBase}`;
      filteredTrades.push({ trade, reason: filterReason });
    } else if (price <= 0 || price < 0.0001 / amountToken) {
      filterReason = `price too small: ${price}`;
      filteredTrades.push({ trade, reason: filterReason });
    } else {
      // Valid trade
      if (side === 'buy' || side === 'add') {
        buyTrades.push(trade);
      } else if (side === 'sell' || side === 'remove') {
        sellTrades.push(trade);
      }
    }
  }

  // 5. Display results
  console.log(`📈 Trade Analysis:\n`);
  console.log(`   ✅ Valid BUY/ADD trades: ${buyTrades.length}`);
  console.log(`   ✅ Valid SELL/REMOVE trades: ${sellTrades.length}`);
  console.log(`   ⚠️  Void trades: ${voidTrades.length}`);
  console.log(`   ⚠️  Filtered trades: ${filteredTrades.length}\n`);

  if (buyTrades.length > 0) {
    console.log(`\n📥 BUY/ADD Trades:`);
    buyTrades.forEach((trade, idx) => {
      const timestamp = new Date((trade as any).timestamp).toISOString();
      const amountBase = Number((trade as any).amountBase || 0);
      const price = Number((trade as any).priceBasePerToken || 0);
      const amountToken = Number((trade as any).amountToken || 0);
      const valueUsd = (trade as any).valueUsd || (trade as any).meta?.valueUsd || null;
      const baseToken = (((trade as any).meta?.baseToken || 'SOL') as string).toUpperCase();
      
      console.log(`   ${idx + 1}. ${timestamp}`);
      console.log(`      - Side: ${(trade as any).side}`);
      console.log(`      - Base: ${baseToken}`);
      console.log(`      - Amount Token: ${amountToken.toFixed(6)}`);
      console.log(`      - Amount Base: ${amountBase.toFixed(6)}`);
      console.log(`      - Price: ${price.toFixed(8)}`);
      console.log(`      - Value USD: ${valueUsd ? `$${Number(valueUsd).toFixed(2)}` : 'null'}`);
      console.log(`      - Trade ID: ${(trade as any).id}`);
    });
  }

  if (sellTrades.length > 0) {
    console.log(`\n📤 SELL/REMOVE Trades:`);
    sellTrades.forEach((trade, idx) => {
      const timestamp = new Date((trade as any).timestamp).toISOString();
      const amountBase = Number((trade as any).amountBase || 0);
      const price = Number((trade as any).priceBasePerToken || 0);
      const amountToken = Number((trade as any).amountToken || 0);
      const valueUsd = (trade as any).valueUsd || (trade as any).meta?.valueUsd || null;
      const baseToken = (((trade as any).meta?.baseToken || 'SOL') as string).toUpperCase();
      
      console.log(`   ${idx + 1}. ${timestamp}`);
      console.log(`      - Side: ${(trade as any).side}`);
      console.log(`      - Base: ${baseToken}`);
      console.log(`      - Amount Token: ${amountToken.toFixed(6)}`);
      console.log(`      - Amount Base: ${amountBase.toFixed(6)}`);
      console.log(`      - Price: ${price.toFixed(8)}`);
      console.log(`      - Value USD: ${valueUsd ? `$${Number(valueUsd).toFixed(2)}` : 'null'}`);
      console.log(`      - Trade ID: ${(trade as any).id}`);
    });
  }

  if (voidTrades.length > 0) {
    console.log(`\n⚠️  Void Trades (excluded from closed lots):`);
    voidTrades.forEach(({ trade, reason }, idx) => {
      const timestamp = new Date((trade as any).timestamp).toISOString();
      console.log(`   ${idx + 1}. ${timestamp} - ${reason}`);
      console.log(`      - Side: ${(trade as any).side}`);
      console.log(`      - Trade ID: ${(trade as any).id}`);
    });
  }

  if (filteredTrades.length > 0) {
    console.log(`\n⚠️  Filtered Trades (excluded from closed lots):`);
    filteredTrades.forEach(({ trade, reason }, idx) => {
      const timestamp = new Date((trade as any).timestamp).toISOString();
      console.log(`   ${idx + 1}. ${timestamp} - ${reason}`);
      console.log(`      - Side: ${(trade as any).side}`);
      console.log(`      - Base: ${((trade as any).meta?.baseToken || 'SOL') as string}`);
      console.log(`      - Trade ID: ${(trade as any).id}`);
    });
  }

  // 6. Check ClosedLot records
  const { data: closedLots } = await supabase
    .from('ClosedLot')
    .select('*')
    .eq('walletId', wallet.id)
    .eq('tokenId', token.id)
    .order('exitTime', { ascending: false });

  console.log(`\n📋 ClosedLot Records: ${closedLots?.length || 0}\n`);

  if (closedLots && closedLots.length > 0) {
    console.log(`   Closed Lots:`);
    closedLots.forEach((lot, idx) => {
      console.log(`   ${idx + 1}. Exit: ${new Date(lot.exitTime).toISOString()}`);
      console.log(`      - Size: ${Number(lot.size).toFixed(6)}`);
      console.log(`      - PnL: ${Number(lot.realizedPnl).toFixed(6)} SOL`);
      console.log(`      - Hold Time: ${lot.holdTimeMinutes} min`);
      console.log(`      - Buy Trade ID: ${lot.buyTradeId || 'synthetic'}`);
      console.log(`      - Sell Trade ID: ${lot.sellTradeId || 'synthetic'}`);
    });
  }

  // 7. Summary
  console.log(`\n📊 Summary:`);
  console.log(`   - Valid BUY trades: ${buyTrades.length}`);
  console.log(`   - Valid SELL trades: ${sellTrades.length}`);
  console.log(`   - ClosedLot records: ${closedLots?.length || 0}`);
  
  if (sellTrades.length > 0 && buyTrades.length === 0) {
    console.log(`\n   ⚠️  WARNING: Has SELL trades but NO BUY trades!`);
    console.log(`   This means the BUY trades are pre-history (before we started tracking).`);
    console.log(`   ClosedLot records cannot be created without cost basis.\n`);
  } else if (sellTrades.length > 0 && closedLots && closedLots.length === 0) {
    console.log(`\n   ⚠️  WARNING: Has SELL and BUY trades but NO ClosedLot records!`);
    console.log(`   This might indicate a problem with lot matching.\n`);
  } else if (sellTrades.length > 0 && closedLots && closedLots.length < sellTrades.length) {
    console.log(`\n   ⚠️  WARNING: Has ${sellTrades.length} SELL trades but only ${closedLots.length} ClosedLot records!`);
    console.log(`   Some SELL trades might not have matching BUY trades.\n`);
  } else {
    console.log(`\n   ✅ All SELL trades have corresponding ClosedLot records!\n`);
  }

  console.log(`✅ Debug complete!\n`);
}

// Get wallet address and token symbol from command line
const walletAddress = process.argv[2];
const tokenSymbol = process.argv[3];

if (!walletAddress || !tokenSymbol) {
  console.error('Usage: pnpm tsx src/scripts/debug-token-trades.ts <walletAddress> <tokenSymbol>');
  console.error('Example: pnpm tsx src/scripts/debug-token-trades.ts DfMxre4cKmvogbLrPigxmibVTTQDuzjdXojWzjCXXhzj P-TOKEN');
  process.exit(1);
}

debugTokenTrades(walletAddress, tokenSymbol).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
