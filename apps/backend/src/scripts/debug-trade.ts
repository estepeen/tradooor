import 'dotenv/config';
import { supabase, TABLES } from '../lib/supabase.js';

const txSignature = process.argv[2];

if (!txSignature) {
  console.error('Usage: pnpm --filter backend debug:trade <txSignature>');
  process.exit(1);
}

async function main() {
  // Find trade
  const { data: trade, error: tradeError } = await supabase
    .from(TABLES.TRADE)
    .select(`
      *,
      token:${TABLES.TOKEN}(*),
      wallet:${TABLES.SMART_WALLET}(id, address, label)
    `)
    .eq('txSignature', txSignature)
    .single();

  if (tradeError || !trade) {
    console.error(`❌ Trade not found: ${txSignature}`);
    console.error('Error:', tradeError?.message);
    process.exit(1);
  }

  console.log('\n📊 Trade Details:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`ID: ${trade.id}`);
  console.log(`TX Signature: ${trade.txSignature}`);
  console.log(`Wallet: ${(trade as any).wallet?.address} (${(trade as any).wallet?.label || 'N/A'})`);
  console.log(`Token: ${(trade as any).token?.symbol || 'N/A'} (${(trade as any).token?.mintAddress?.substring(0, 16)}...)`);
  console.log(`Side: ${trade.side.toUpperCase()}`);
  console.log(`Timestamp: ${new Date(trade.timestamp).toISOString()}`);
  console.log(`DEX: ${trade.dex}`);
  console.log('');

  const amountToken = Number(trade.amountToken);
  const amountBase = Number(trade.amountBase);
  const priceBasePerToken = Number(trade.priceBasePerToken);
  const valueUsd = Number(trade.valueUsd || 0);
  const meta = (trade as any).meta || {};
  const baseToken = meta.baseToken || 'SOL';
  const valuationSource = meta.valuationSource;
  const amountBaseRaw = meta.amountBaseRaw;
  const priceBasePerTokenRaw = meta.priceBasePerTokenRaw;

  console.log('💰 Trade Values:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Amount Token: ${amountToken.toFixed(6)}`);
  console.log(`Amount Base (stored): ${amountBase.toFixed(6)} (${baseToken})`);
  console.log(`Price Base Per Token (stored): ${priceBasePerToken.toFixed(6)} (${baseToken})`);
  console.log(`Value USD (stored): $${valueUsd.toFixed(2)}`);
  console.log('');

  if (amountBaseRaw !== undefined) {
    console.log('📝 Raw Values (from normalized trade):');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Amount Base Raw: ${Number(amountBaseRaw).toFixed(6)} (${baseToken})`);
    console.log(`Price Base Per Token Raw: ${Number(priceBasePerTokenRaw || 0).toFixed(6)} (${baseToken})`);
    console.log(`Valuation Source: ${valuationSource || 'N/A'}`);
    console.log('');

    // Calculate expected values
    if (baseToken === 'SOL' || baseToken === 'WSOL') {
      console.log('🔍 Expected Calculation (SOL base):');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`1. amountBaseRaw = ${Number(amountBaseRaw).toFixed(6)} SOL`);
      console.log(`2. Need SOL price at timestamp: ${new Date(trade.timestamp).toISOString()}`);
      console.log(`3. Expected: USD value = amountBaseRaw * solPrice`);
      console.log(`4. Expected: priceUsdPerToken = USD value / amountToken`);
      console.log(`   = (${Number(amountBaseRaw).toFixed(6)} * solPrice) / ${amountToken.toFixed(6)}`);
      console.log('');
      console.log(`Current stored valueUsd: $${valueUsd.toFixed(2)}`);
      console.log(`If solPrice = $150: USD value = ${(Number(amountBaseRaw) * 150).toFixed(2)}, priceUsdPerToken = ${((Number(amountBaseRaw) * 150) / amountToken).toFixed(6)}`);
      console.log(`If solPrice = $200: USD value = ${(Number(amountBaseRaw) * 200).toFixed(2)}, priceUsdPerToken = ${((Number(amountBaseRaw) * 200) / amountToken).toFixed(6)}`);
    } else {
      console.log('🔍 Expected Calculation (non-SOL base):');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`Base Token: ${baseToken}`);
      console.log(`Valuation Source: ${valuationSource || 'N/A'}`);
      console.log(`Expected: USD value = amountBaseRaw * baseTokenPrice`);
      console.log(`Current stored valueUsd: $${valueUsd.toFixed(2)}`);
    }
  }

  // Check normalized trade
  const { data: normalizedTrade } = await supabase
    .from('NormalizedTrade')
    .select('*')
    .eq('txSignature', txSignature)
    .single();

  if (normalizedTrade) {
    console.log('');
    console.log('📦 Normalized Trade:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Status: ${normalizedTrade.status}`);
    console.log(`Amount Token: ${Number(normalizedTrade.amountToken).toFixed(6)}`);
    console.log(`Amount Base Raw: ${Number(normalizedTrade.amountBaseRaw).toFixed(6)}`);
    console.log(`Price Base Per Token Raw: ${Number(normalizedTrade.priceBasePerTokenRaw).toFixed(6)}`);
    console.log(`Base Token: ${normalizedTrade.baseToken}`);
    if (normalizedTrade.amountBaseUsd) {
      console.log(`Amount Base USD: ${Number(normalizedTrade.amountBaseUsd).toFixed(2)}`);
    }
    if (normalizedTrade.priceUsdPerToken) {
      console.log(`Price USD Per Token: ${Number(normalizedTrade.priceUsdPerToken).toFixed(6)}`);
    }
    console.log(`Valuation Source: ${normalizedTrade.valuationSource || 'N/A'}`);
    if (normalizedTrade.error) {
      console.log(`Error: ${normalizedTrade.error}`);
    }
  }

  console.log('');
}

main().catch((error) => {
  console.error('❌ Script failed:', error.message);
  process.exit(1);
});

