/**
 * Find potential liquidity trades for a specific wallet
 * Looks for high-value trades that might be liquidity operations
 * 
 * Usage: pnpm find:liquidity-trades <walletAddress>
 */

import { createClient } from '@supabase/supabase-js';
import { TABLES } from '../lib/supabase.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const smartWalletRepo = new SmartWalletRepository();

async function findLiquidityTrades(walletAddress: string) {
  console.log(`\n🔍 Finding potential liquidity trades for wallet: ${walletAddress}\n`);

  try {
    // Find wallet
    const wallet = await smartWalletRepo.findByAddress(walletAddress);
    if (!wallet) {
      console.error(`❌ Wallet not found: ${walletAddress}`);
      process.exit(1);
    }

    console.log(`✅ Wallet found: ${wallet.label || wallet.address}`);
    console.log(`   ID: ${wallet.id}\n`);

    // Get all trades for this wallet
    const { data: trades, error: fetchError } = await supabase
      .from(TABLES.TRADE)
      .select('id, txSignature, side, amountBase, amountToken, priceBasePerToken, meta, dex, timestamp, token:Token(symbol, name, mintAddress)')
      .eq('walletId', wallet.id)
      .order('amountBase', { ascending: false })
      .limit(1000);

    if (fetchError) {
      throw new Error(`Failed to fetch trades: ${fetchError.message}`);
    }

    if (!trades || trades.length === 0) {
      console.log('✅ No trades found');
      return;
    }

    console.log(`📊 Found ${trades.length} trades\n`);

    // Find high-value trades (potential liquidity)
    const HIGH_VALUE_THRESHOLD = 33; // ~5000 USD at ~150 USD per SOL
    const highValueTrades = trades.filter((trade: any) => {
      return Number(trade.amountBase) > HIGH_VALUE_THRESHOLD && trade.side !== 'void';
    });

    console.log(`💰 High-value trades (>${HIGH_VALUE_THRESHOLD} SOL / ~5000 USD): ${highValueTrades.length}\n`);

    if (highValueTrades.length > 0) {
      console.log('Top 20 high-value trades:');
      highValueTrades.slice(0, 20).forEach((trade: any, idx: number) => {
        const token = trade.token as any;
        const meta = trade.meta as any;
        console.log(`\n${idx + 1}. ${trade.txSignature.substring(0, 16)}...`);
        console.log(`   Side: ${trade.side}`);
        console.log(`   Amount Base: ${Number(trade.amountBase).toFixed(2)}`);
        console.log(`   Amount Token: ${Number(trade.amountToken).toFixed(2)}`);
        console.log(`   Token: ${token?.symbol || 'N/A'} (${token?.mintAddress?.substring(0, 16) || 'N/A'}...)`);
        console.log(`   DEX: ${trade.dex}`);
        console.log(`   Timestamp: ${new Date(trade.timestamp).toISOString()}`);
        console.log(`   Meta: ${JSON.stringify(meta).substring(0, 200)}`);
      });
    }

    // Group trades by signature to find potential liquidity (BUY + SELL in same tx)
    const tradesBySignature = new Map<string, any[]>();
    trades.forEach((trade: any) => {
      if (!tradesBySignature.has(trade.txSignature)) {
        tradesBySignature.set(trade.txSignature, []);
      }
      tradesBySignature.get(trade.txSignature)!.push(trade);
    });

    // Find signatures with both BUY and SELL
    const potentialLiquiditySignatures = new Set<string>();
    tradesBySignature.forEach((txTrades, signature) => {
      if (txTrades.length >= 2) {
        const hasBuy = txTrades.some((t: any) => t.side === 'buy');
        const hasSell = txTrades.some((t: any) => t.side === 'sell');
        if (hasBuy && hasSell) {
          const uniqueTokens = new Set(txTrades.map((t: any) => (t.token as any)?.mintAddress).filter(Boolean));
          if (uniqueTokens.size >= 2) {
            potentialLiquiditySignatures.add(signature);
          }
        }
      }
    });

    console.log(`\n\n🔄 Signatures with both BUY and SELL for different tokens: ${potentialLiquiditySignatures.size}\n`);

    if (potentialLiquiditySignatures.size > 0) {
      console.log('Sample signatures (first 10):');
      Array.from(potentialLiquiditySignatures).slice(0, 10).forEach((signature, idx) => {
        const txTrades = tradesBySignature.get(signature) || [];
        console.log(`\n${idx + 1}. ${signature.substring(0, 16)}...`);
        console.log(`   Trades: ${txTrades.length}`);
        txTrades.forEach((trade: any) => {
          const token = trade.token as any;
          console.log(`     - ${trade.side} | ${Number(trade.amountBase).toFixed(2)} base | ${token?.symbol || 'N/A'}`);
        });
      });
    }

    // Calculate total PnL impact
    const totalAmountBase = trades
      .filter((t: any) => t.side !== 'void')
      .reduce((sum: number, t: any) => sum + Number(t.amountBase), 0);
    
    const highValueTotal = highValueTrades.reduce((sum: number, t: any) => sum + Number(t.amountBase), 0);

    console.log(`\n\n📊 Summary:`);
    console.log(`   Total trades: ${trades.length}`);
    console.log(`   Non-void trades: ${trades.filter((t: any) => t.side !== 'void').length}`);
    console.log(`   Total amountBase (non-void): ${totalAmountBase.toFixed(2)}`);
    console.log(`   High-value trades: ${highValueTrades.length}`);
    console.log(`   High-value total: ${highValueTotal.toFixed(2)}`);
    console.log(`   Potential liquidity signatures: ${potentialLiquiditySignatures.size}`);

  } catch (error: any) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Main
const walletAddress = process.argv[2];
if (!walletAddress) {
  console.error('Usage: pnpm find:liquidity-trades <walletAddress>');
  process.exit(1);
}

findLiquidityTrades(walletAddress).then(() => {
  process.exit(0);
}).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
