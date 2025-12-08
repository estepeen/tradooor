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

async function reprocessAllVoidTrades() {
  console.log(`\n🔄 Reprocessing ALL VOID trades for ALL wallets...\n`);

  // 1. Get all VOID trades
  const { data: voidTrades, error: tradesError } = await supabase
    .from(TABLES.TRADE)
    .select('id, txSignature, tokenId, walletId')
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

  // 2. Setup RPC connection
  const rpcUrl = process.env.QUICKNODE_RPC_URL || process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    console.error('❌ No RPC URL configured (QUICKNODE_RPC_URL or SOLANA_RPC_URL)');
    process.exit(1);
  }
  const connection = new Connection(rpcUrl, 'confirmed');

  // 3. Get wallet addresses for all walletIds
  const walletIds = [...new Set(voidTrades.map(t => t.walletId))];
  const { data: wallets, error: walletsError } = await supabase
    .from(TABLES.SMART_WALLET)
    .select('id, address')
    .in('id', walletIds);

  if (walletsError) {
    console.error(`❌ Error fetching wallets: ${walletsError.message}`);
    process.exit(1);
  }

  const walletIdToAddress = new Map<string, string>();
  for (const wallet of wallets || []) {
    walletIdToAddress.set(wallet.id, wallet.address);
  }

  // 4. Group by wallet address
  const tradesByWallet = new Map<string, typeof voidTrades>();
  for (const trade of voidTrades) {
    const walletAddress = walletIdToAddress.get(trade.walletId);
    if (!walletAddress) {
      console.warn(`⚠️  Wallet not found for walletId: ${trade.walletId}, skipping trade ${trade.txSignature.substring(0, 16)}...`);
      continue;
    }
    if (!tradesByWallet.has(walletAddress)) {
      tradesByWallet.set(walletAddress, []);
    }
    tradesByWallet.get(walletAddress)!.push(trade);
  }

  console.log(`📋 Processing ${tradesByWallet.size} wallets\n`);

  let totalProcessed = 0;
  let totalSaved = 0;
  let totalStillVoid = 0;
  let totalErrors = 0;

  // 5. Process each wallet
  for (const [walletAddress, trades] of tradesByWallet.entries()) {
    console.log(`\n🔍 Processing wallet: ${walletAddress.substring(0, 8)}... (${trades.length} VOID trades)`);

    let walletProcessed = 0;
    let walletSaved = 0;
    let walletStillVoid = 0;
    let walletErrors = 0;

    for (const trade of trades) {
      try {
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
          walletErrors++;
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

        walletProcessed++;
        if (result.saved) {
          // Check if it's still void
          const { data: newTrade } = await supabase
            .from(TABLES.TRADE)
            .select('side, valueUsd')
            .eq('txSignature', trade.txSignature)
            .single();

          if (newTrade?.side === 'void') {
            walletStillVoid++;
          } else {
            walletSaved++;
            if (walletSaved % 10 === 0) {
              console.log(`   ✅ Reprocessed ${walletSaved} as normal trades`);
            }
          }
        } else {
          walletErrors++;
        }

        // Rate limiting - increased delay to avoid QuickNode limits
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error: any) {
        walletErrors++;
        const errorMsg = error.message || String(error);
        
        // Check for rate limit errors
        if (errorMsg.includes('429') || errorMsg.includes('rate limit') || errorMsg.includes('daily request limit')) {
          console.error(`\n   ❌ RATE LIMIT REACHED! QuickNode daily limit exceeded.`);
          console.error(`   💡 Options:`);
          console.error(`      1. Wait 24 hours and continue`);
          console.error(`      2. Upgrade QuickNode plan`);
          console.error(`      3. Use different RPC endpoint`);
          console.error(`\n   📊 Progress so far:`);
          console.error(`      Processed: ${walletProcessed}/${trades.length} trades`);
          console.error(`      Saved as normal: ${walletSaved}`);
          console.error(`      Still VOID: ${walletStillVoid}`);
          console.error(`      Errors: ${walletErrors}\n`);
          
          // Exit gracefully so user can resume later
          process.exit(1);
        }
        
        if (walletErrors <= 3) {
          console.warn(`   ⚠️  Error processing ${trade.txSignature.substring(0, 16)}...: ${errorMsg}`);
        }
        
        // If too many errors, skip this wallet
        if (walletErrors > 10) {
          console.warn(`   ⚠️  Too many errors for this wallet, skipping remaining trades`);
          break;
        }
      }
    }

    console.log(`   📊 Wallet summary: ${walletProcessed} processed, ${walletSaved} saved as normal, ${walletStillVoid} still VOID, ${walletErrors} errors`);
    totalProcessed += walletProcessed;
    totalSaved += walletSaved;
    totalStillVoid += walletStillVoid;
    totalErrors += walletErrors;
  }

  console.log(`\n✅ Reprocessing complete!`);
  console.log(`   Total processed: ${totalProcessed}`);
  console.log(`   Saved as normal trades: ${totalSaved}`);
  console.log(`   Still VOID: ${totalStillVoid}`);
  console.log(`   Errors: ${totalErrors}\n`);
}

reprocessAllVoidTrades().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

