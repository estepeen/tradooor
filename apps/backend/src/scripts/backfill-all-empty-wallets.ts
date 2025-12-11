import 'dotenv/config';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { SolanaCollectorService } from '../services/solana-collector.service.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { WalletProcessingQueueRepository } from '../repositories/wallet-processing-queue.repository.js';
import { NormalizedTradeRepository } from '../repositories/normalized-trade.repository.js';

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

/**
 * Backfill všechny wallets bez trades
 */
async function backfillAllEmptyWallets(hoursBack: number = 168) {
  console.log(`\n🔄 Backfilling všechny wallets bez trades (posledních ${hoursBack} hodin)...\n`);

  // 1. Najít všechny wallets bez trades
  const allWallets = await smartWalletRepo.findAll({ page: 1, pageSize: 10000 });
  const walletsWithoutTrades: string[] = [];

  for (const wallet of allWallets.wallets) {
    const { total } = await tradeRepo.findByWalletId(wallet.id, { pageSize: 1 });
    if (total === 0) {
      walletsWithoutTrades.push(wallet.address);
    }
  }

  console.log(`📊 Nalezeno ${walletsWithoutTrades.length} wallets bez trades z celkem ${allWallets.wallets.length}\n`);

  if (walletsWithoutTrades.length === 0) {
    console.log(`✅ Všechny wallets mají trades!\n`);
    return;
  }

  // 2. Setup RPC
  const rpcUrl = process.env.QUICKNODE_RPC_URL || process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    console.error('❌ No RPC URL configured (QUICKNODE_RPC_URL or SOLANA_RPC_URL)');
    process.exit(1);
  }
  const connection = new Connection(rpcUrl, 'confirmed');

  const now = Date.now();
  const startTime = now - (hoursBack * 60 * 60 * 1000);
  const startTimeSec = Math.floor(startTime / 1000);

  console.log(`📅 Time range:`);
  console.log(`   From: ${new Date(startTime).toLocaleString()}`);
  console.log(`   To: ${new Date(now).toLocaleString()}\n`);

  let totalProcessed = 0;
  let totalSaved = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let walletsWithTrades = 0;

  // 3. Process each wallet
  for (let i = 0; i < walletsWithoutTrades.length; i++) {
    const walletAddress = walletsWithoutTrades[i];
    console.log(`\n[${i + 1}/${walletsWithoutTrades.length}] 🔍 Processing wallet: ${walletAddress.substring(0, 8)}...`);

    let walletProcessed = 0;
    let walletSaved = 0;
    let walletSkipped = 0;
    let walletErrors = 0;

    try {
      const walletPubkey = new PublicKey(walletAddress);
      let before: string | undefined = undefined;

      while (true) {
        try {
          const signatures = await connection.getSignaturesForAddress(
            walletPubkey,
            {
              limit: 1000,
              before,
            },
            'confirmed'
          );

          if (signatures.length === 0) break;

          const relevantSigs = signatures.filter(sig => {
            return sig.blockTime && sig.blockTime >= startTimeSec;
          });

          for (const sigInfo of relevantSigs) {
            try {
              // Check if already exists
              const existing = await tradeRepo.findBySignature(sigInfo.signature);
              if (existing) {
                walletSkipped++;
                continue;
              }

              // Fetch full transaction
              const tx = await connection.getTransaction(sigInfo.signature, {
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed',
              });

              if (!tx) {
                walletSkipped++;
                continue;
              }

              // Convert to QuickNode format
              const quickNodeTx = {
                transaction: {
                  signatures: [sigInfo.signature],
                  message: tx.transaction.message,
                },
                meta: tx.meta,
                slot: tx.slot,
                blockTime: tx.blockTime,
              };

              // Process transaction
              const result = await collectorService.processQuickNodeTransaction(
                quickNodeTx,
                walletAddress,
                tx.blockTime ?? undefined
              );

              walletProcessed++;
              if (result.saved) {
                walletSaved++;
              } else {
                walletSkipped++;
              }

              // Rate limiting
              await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (error: any) {
              walletErrors++;
              const errorMsg = error.message || String(error);
              
              // Check for rate limit errors
              if (errorMsg.includes('429') || errorMsg.includes('rate limit') || errorMsg.includes('daily request limit')) {
                console.error(`\n   ❌ RATE LIMIT REACHED! QuickNode daily limit exceeded.`);
                console.error(`   💡 Stopping backfill. Processed ${i + 1}/${walletsWithoutTrades.length} wallets so far.`);
                console.error(`   📊 Progress:`);
                console.error(`      Total processed: ${totalProcessed}`);
                console.error(`      Total saved: ${totalSaved}`);
                console.error(`      Wallets with trades found: ${walletsWithTrades}\n`);
                process.exit(1);
              }
              
              if (walletErrors <= 3) {
                console.warn(`   ⚠️  Error processing ${sigInfo.signature.substring(0, 16)}...: ${errorMsg}`);
              }
            }
          }

          // Check if we need to continue
          if (signatures.length < 1000) break;

          const oldestSig = signatures[signatures.length - 1];
          if (oldestSig.blockTime && oldestSig.blockTime < startTimeSec) {
            break;
          }

          before = signatures[signatures.length - 1].signature;
        } catch (error: any) {
          const errorMsg = error.message || String(error);
          if (errorMsg.includes('429') || errorMsg.includes('rate limit') || errorMsg.includes('daily request limit')) {
            console.error(`\n   ❌ RATE LIMIT REACHED!`);
            process.exit(1);
          }
          walletErrors++;
          if (walletErrors <= 3) {
            console.warn(`   ⚠️  Error fetching signatures: ${errorMsg}`);
          }
          break; // Skip this wallet if too many errors
        }
      }

      // Check if wallet now has trades
      const wallet = await smartWalletRepo.findByAddress(walletAddress);
      if (wallet) {
        const { total } = await tradeRepo.findByWalletId(wallet.id, { pageSize: 1 });
        if (total > 0) {
          walletsWithTrades++;
          console.log(`   ✅ Wallet nyní má ${total} trades!`);
        }
      }

      console.log(`   📊 Wallet summary: ${walletProcessed} processed, ${walletSaved} saved, ${walletSkipped} skipped, ${walletErrors} errors`);

      totalProcessed += walletProcessed;
      totalSaved += walletSaved;
      totalSkipped += walletSkipped;
      totalErrors += walletErrors;

    } catch (error: any) {
      totalErrors++;
      console.error(`   ❌ Fatal error for wallet ${walletAddress}: ${error.message}`);
    }
  }

  console.log(`\n✅ Backfill complete!`);
  console.log(`   Total wallets processed: ${walletsWithoutTrades.length}`);
  console.log(`   Wallets with trades found: ${walletsWithTrades}`);
  console.log(`   Total transactions processed: ${totalProcessed}`);
  console.log(`   Total trades saved: ${totalSaved}`);
  console.log(`   Total skipped: ${totalSkipped}`);
  console.log(`   Total errors: ${totalErrors}\n`);
}

const hoursBack = parseInt(process.argv[2]) || 168; // Default 7 days

backfillAllEmptyWallets(hoursBack).catch((error) => {
  console.error('❌ Script failed:', error);
  process.exit(1);
});

