/**
 * Find tokens by name/symbol and show their trades
 * Usage: pnpm tsx src/scripts/find-token-by-name.ts <walletAddress> <searchTerm>
 */

import { supabase, TABLES } from '../lib/supabase.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';

async function findTokenByName(walletAddress: string, searchTerm: string) {
  console.log(`\n🔍 Searching for tokens matching: "${searchTerm}" in wallet: ${walletAddress}\n`);

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

  // 2. Find tokens by symbol or name
  const { data: tokensBySymbol, error: symbolError } = await supabase
    .from(TABLES.TOKEN)
    .select('*')
    .ilike('symbol', `%${searchTerm}%`);

  const { data: tokensByName, error: nameError } = await supabase
    .from(TABLES.TOKEN)
    .select('*')
    .ilike('name', `%${searchTerm}%`);

  const allTokens = new Map<string, any>();
  
  (tokensBySymbol || []).forEach(token => {
    allTokens.set(token.id, token);
  });
  
  (tokensByName || []).forEach(token => {
    allTokens.set(token.id, token);
  });

  const tokens = Array.from(allTokens.values());

  if (tokens.length === 0) {
    console.log(`❌ No tokens found matching "${searchTerm}"`);
    process.exit(1);
  }

  console.log(`✅ Found ${tokens.length} token(s) matching "${searchTerm}":\n`);

  // 3. Get all trades for this wallet
  const allTrades = await tradeRepo.findAllForMetrics(wallet.id);
  console.log(`📊 Total trades for wallet: ${allTrades?.length || 0}\n`);

  // 4. Check trades for each token
  for (const token of tokens) {
    const tokenTrades = (allTrades || []).filter(t => (t as any).tokenId === token.id);
    
    const buyTrades = tokenTrades.filter(t => {
      const side = ((t as any).side || '').toLowerCase();
      return side === 'buy' || side === 'add';
    });
    
    const sellTrades = tokenTrades.filter(t => {
      const side = ((t as any).side || '').toLowerCase();
      return side === 'sell' || side === 'remove';
    });

    const voidTrades = tokenTrades.filter(t => {
      const side = ((t as any).side || '').toLowerCase();
      return side === 'void';
    });

    console.log(`📦 Token: ${token.symbol || token.name || 'Unknown'} (ID: ${token.id})`);
    console.log(`   - Mint: ${token.mintAddress || 'N/A'}`);
    console.log(`   - Total trades: ${tokenTrades.length}`);
    console.log(`   - BUY/ADD trades: ${buyTrades.length}`);
    console.log(`   - SELL/REMOVE trades: ${sellTrades.length}`);
    console.log(`   - VOID trades: ${voidTrades.length}`);

    // Check ClosedLot records
    const { data: closedLots } = await supabase
      .from('ClosedLot')
      .select('*')
      .eq('walletId', wallet.id)
      .eq('tokenId', token.id);

    console.log(`   - ClosedLot records: ${closedLots?.length || 0}`);

    if (sellTrades.length > 0 && closedLots && closedLots.length === 0) {
      console.log(`   ⚠️  WARNING: Has SELL trades but NO ClosedLot records!`);
    }

    if (tokenTrades.length > 0) {
      // Show first few trades
      console.log(`\n   Recent trades:`);
      const recentTrades = tokenTrades
        .sort((a, b) => new Date((b as any).timestamp).getTime() - new Date((a as any).timestamp).getTime())
        .slice(0, 5);
      
      for (const trade of recentTrades) {
        const timestamp = new Date((trade as any).timestamp).toISOString();
        const side = (trade as any).side || 'unknown';
        const amountToken = Number((trade as any).amountToken || 0);
        const amountBase = Number((trade as any).amountBase || 0);
        console.log(`      - ${timestamp}: ${side} - ${amountToken.toFixed(2)} tokens (${amountBase.toFixed(6)} SOL)`);
      }
    }

    console.log(``);
  }

  // 5. Summary
  console.log(`\n📊 Summary:`);
  console.log(`   - Found ${tokens.length} token(s) matching "${searchTerm}"`);
  
  const tokensWithTrades = tokens.filter(t => {
    const tokenTrades = (allTrades || []).filter(tr => (tr as any).tokenId === t.id);
    return tokenTrades.length > 0;
  });
  
  console.log(`   - ${tokensWithTrades.length} token(s) have trades`);
  
  console.log(`\n✅ Search complete!\n`);
}

// Get wallet address and search term from command line
const walletAddress = process.argv[2];
const searchTerm = process.argv[3];

if (!walletAddress || !searchTerm) {
  console.error('Usage: pnpm tsx src/scripts/find-token-by-name.ts <walletAddress> <searchTerm>');
  console.error('Example: pnpm tsx src/scripts/find-token-by-name.ts DfMxre4cKmvogbLrPigxmibVTTQDuzjdXojWzjCXXhzj P-TOKEN');
  process.exit(1);
}

findTokenByName(walletAddress, searchTerm).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
