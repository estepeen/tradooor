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
    .select('*, wallet:smart_wallet(address)')
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

  // 3. Group by wallet
  const tradesByWallet = new Map<string, typeof voidTrades>();
  for (const trade of voidTrades) {
    const walletAddress = (trade.wallet as any)?.address;
    if (!walletAddress) continue;
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

  // 4. Process each wallet
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

        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error: any) {
        walletErrors++;
        if (walletErrors <= 3) {
          console.warn(`   ⚠️  Error processing ${trade.txSignature.substring(0, 16)}...: ${error.message}`);
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

