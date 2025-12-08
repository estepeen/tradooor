import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { SolanaCollectorService } from '../services/solana-collector.service.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
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

async function backfillAllWallets(hoursBack: number = 24) {
  console.log(`\n🔄 Starting backfill for ALL wallets (last ${hoursBack} hours)...\n`);

  // 1. Get all tracked wallets
  const allWallets = await smartWalletRepo.findAll({ page: 1, pageSize: 10000 });
  console.log(`📋 Found ${allWallets.wallets.length} tracked wallets\n`);

  // 2. Setup RPC connection
  const rpcUrl = process.env.QUICKNODE_RPC_URL || process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    console.error('❌ No RPC URL configured (QUICKNODE_RPC_URL or SOLANA_RPC_URL)');
    process.exit(1);
  }
  console.log(`📡 Connecting to RPC: ${rpcUrl.substring(0, 50)}...\n`);
  const connection = new Connection(rpcUrl, 'confirmed');

  // 3. Calculate time range
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

  // 4. Process each wallet
  for (const wallet of allWallets.wallets) {
    console.log(`\n🔍 Processing wallet: ${wallet.label || wallet.address} (${wallet.address.substring(0, 8)}...)`);

    try {
      const walletPubkey = new PublicKey(wallet.address);
      
      // Get signatures for this wallet
      let before: string | undefined = undefined;
      let walletProcessed = 0;
      let walletSaved = 0;
      let walletSkipped = 0;
      let walletErrors = 0;

      while (true) {
        const signatures = await connection.getSignaturesForAddress(
          walletPubkey,
          {
            limit: 1000,
            before,
          },
          'confirmed'
        );

        if (signatures.length === 0) {
          break;
        }

        // Filter by time
        const relevantSigs = signatures.filter(sig => {
          if (!sig.blockTime) return false;
          const sigTime = sig.blockTime * 1000;
          return sigTime >= startTime && sigTime <= now;
        });

        if (relevantSigs.length === 0) {
          // If oldest signature is before our time range, we're done
          const oldestSig = signatures[signatures.length - 1];
          if (oldestSig.blockTime && oldestSig.blockTime < startTimeSec) {
            break;
          }
          if (signatures.length < 1000) break;
          before = signatures[signatures.length - 1].signature;
          continue;
        }

        // Process each relevant transaction
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
              wallet.address,
              tx.blockTime
            );

            walletProcessed++;
            if (result.saved) {
              walletSaved++;
              if (walletSaved % 10 === 0) {
                const timestamp = sigInfo.blockTime ? new Date(sigInfo.blockTime * 1000).toLocaleString() : 'N/A';
                console.log(`   ✅ Saved ${walletSaved} trades (last: ${timestamp})`);
              }
            } else {
              walletSkipped++;
            }

            // Rate limiting
            await new Promise(resolve => setTimeout(resolve, 100));
          } catch (error: any) {
            walletErrors++;
            if (walletErrors <= 3) {
              console.warn(`   ⚠️  Error processing ${sigInfo.signature.substring(0, 16)}...: ${error.message}`);
            }
            if (walletErrors > 10) {
              console.error(`   ❌ Too many errors for this wallet, skipping`);
              break;
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
      }

      console.log(`   📊 Wallet summary: ${walletProcessed} processed, ${walletSaved} saved, ${walletSkipped} skipped, ${walletErrors} errors`);
      totalProcessed += walletProcessed;
      totalSaved += walletSaved;
      totalSkipped += walletSkipped;
      totalErrors += walletErrors;
    } catch (error: any) {
      totalErrors++;
      console.error(`   ❌ Error processing wallet ${wallet.address}: ${error.message}`);
    }
  }

  console.log(`\n✅ Backfill complete!`);
  console.log(`   Total processed: ${totalProcessed}`);
  console.log(`   Total saved: ${totalSaved}`);
  console.log(`   Total skipped: ${totalSkipped}`);
  console.log(`   Total errors: ${totalErrors}\n`);
}

// Run script
const hoursBack = parseInt(process.argv[2]) || 24;

backfillAllWallets(hoursBack).catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

