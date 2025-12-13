/**
 * Check a specific trade by signature
 * 
 * Usage: pnpm check:specific-trade <signature>
 */

import { createClient } from '@supabase/supabase-js';
import { TABLES } from '../lib/supabase.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function checkTrade(signature: string) {
  console.log(`\n🔍 Checking trade: ${signature}\n`);

  const { data: trades, error } = await supabase
    .from(TABLES.TRADE)
    .select('*, wallet:SmartWallet(address, label), token:Token(symbol, name, mintAddress)')
    .eq('txSignature', signature);

  if (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }

  if (!trades || trades.length === 0) {
    console.log('❌ Trade not found');
    process.exit(1);
  }

  trades.forEach((trade: any) => {
    console.log(`Trade ID: ${trade.id}`);
    console.log(`Wallet: ${(trade.wallet as any)?.label || (trade.wallet as any)?.address}`);
    console.log(`Token: ${(trade.token as any)?.symbol || 'N/A'} (${(trade.token as any)?.mintAddress?.substring(0, 16) || 'N/A'}...)`);
    console.log(`Side: ${trade.side}`);
    console.log(`Amount Base: ${Number(trade.amountBase).toFixed(2)}`);
    console.log(`Amount Token: ${Number(trade.amountToken).toFixed(2)}`);
    console.log(`Price: ${Number(trade.priceBasePerToken).toFixed(6)}`);
    console.log(`DEX: ${trade.dex}`);
    console.log(`Timestamp: ${new Date(trade.timestamp).toISOString()}`);
    console.log(`Meta: ${JSON.stringify(trade.meta, null, 2)}`);
    console.log('');
  });
}

const signature = process.argv[2];
if (!signature) {
  console.error('Usage: pnpm check:specific-trade <signature>');
  process.exit(1);
}

checkTrade(signature).then(() => {
  process.exit(0);
}).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
