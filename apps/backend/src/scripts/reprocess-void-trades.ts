import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { SolanaCollectorService } from '../services/solana-collector.service.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { WalletProcessingQueueRepository } from '../repositories/wallet-processing-queue.repository.js';
import { NormalizedTradeRepository } from '../repositories/normalized-trade.repository.js';
import { supabase, TABLES } from '../lib/supabase.js';

const smartWalletRepo = new SmartWalletRepository();
const tradeRepo = new TradeRepository();
const tokenRepo = new TokenRepository();
const walletQueueRepo = new WalletProcessingQueueRepository();
const normalizedTradeRepo = new NormalizedTradeRepository();
const collectorService = new SolanaCollectorService(
  smartWalletRepo,
  tradeRepo,
  tokenRepo,
  walletQueueRepo,
  normalizedTradeRepo
);

async function reprocessVoidTrades(walletAddress: string) {
  console.log(`\n🔄 Reprocessing VOID trades for wallet: ${walletAddress}\n`);

  // 1. Find wallet
  const wallet = await smartWalletRepo.findByAddress(walletAddress);
  if (!wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }
  console.log(`✅ Found wallet: ${wallet.label || wallet.address} (ID: ${wallet.id})\n`);

  // 2. Get all VOID trades for this wallet
  const { data: voidTrades, error: tradesError } = await supabase
    .from(TABLES.TRADE)
    .select('*')
    .eq('walletId', wallet.id)
    .eq('side', 'void')
    .order('timestamp', { ascending: false });

  if (tradesError) {
    console.error(`❌ Error fetching VOID trades: ${tradesError.message}`);
    process.exit(1);
  }

  console.log(`📊 Found ${voidTrades?.length || 0} VOID trades to reprocess\n`);

  if (!voidTrades || voidTrades.length === 0) {
    console.log(`✅ No VOID trades to reprocess\n`);
    return;
  }

  // 3. Setup RPC connection
  const rpcUrl = process.env.QUICKNODE_RPC_URL || process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    console.error('❌ No RPC URL configured (QUICKNODE_RPC_URL or SOLANA_RPC_URL)');
    process.exit(1);
  }
  const connection = new Connection(rpcUrl, 'confirmed');

  let processed = 0;
  let saved = 0;
  let stillVoid = 0;
  let errors = 0;

  // 4. Process each VOID trade
  for (const trade of voidTrades) {
    try {
      console.log(`\n🔍 Processing: ${trade.txSignature.substring(0, 16)}... (${new Date(trade.timestamp).toLocaleString()})`);

      // Delete existing trade and normalized trade
      await supabase
        .from('NormalizedTrade')
        .delete()
        .eq('txSignature', trade.txSignature);

      await supabase
        .from(TABLES.TRADE)
        .delete()
        .eq('txSignature', trade.txSignature);

      // Fetch transaction from RPC
      const tx = await connection.getTransaction(trade.txSignature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!tx) {
        console.warn(`   ⚠️  Transaction not found on-chain, skipping`);
        errors++;
        continue;
      }

      // Convert to QuickNode format
      const quickNodeTx = {
        transaction: {
          signatures: [trade.txSignature],
          message: tx.transaction.message,
        },
        meta: tx.meta,
        slot: tx.slot,
        blockTime: tx.blockTime,
      };

      // Process transaction with new logic
      const result = await collectorService.processQuickNodeTransaction(
        quickNodeTx,
        walletAddress,
        tx.blockTime
      );

      processed++;
      if (result.saved) {
        // Check if it's still void
        const { data: newTrade } = await supabase
          .from(TABLES.TRADE)
          .select('side, valueUsd')
          .eq('txSignature', trade.txSignature)
          .single();

        if (newTrade?.side === 'void') {
          stillVoid++;
          console.log(`   ⏭️  Still VOID (no SOL/USDC/USDT change detected)`);
        } else {
          saved++;
          const value = newTrade?.valueUsd ? `$${Number(newTrade.valueUsd).toFixed(2)}` : 'N/A';
          console.log(`   ✅ Reprocessed as ${newTrade?.side?.toUpperCase()} - Value: ${value}`);
        }
      } else {
        errors++;
        console.warn(`   ⚠️  Failed to reprocess: ${result.reason || 'unknown'}`);
      }

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error: any) {
      errors++;
      console.error(`   ❌ Error processing ${trade.txSignature.substring(0, 16)}...: ${error.message}`);
    }
  }

  console.log(`\n✅ Reprocessing complete!`);
  console.log(`   Processed: ${processed}`);
  console.log(`   Saved as normal trades: ${saved}`);
  console.log(`   Still VOID: ${stillVoid}`);
  console.log(`   Errors: ${errors}\n`);
}

// Run script
const walletAddress = process.argv[2];

if (!walletAddress) {
  console.error('Usage: pnpm reprocess-void-trades <walletAddress>');
  console.error('Example: pnpm reprocess-void-trades 2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f');
  process.exit(1);
}

reprocessVoidTrades(walletAddress).catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

