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

async function backfillWalletTrades(walletAddress: string, hoursBack: number = 24) {
  console.log(`\n🔄 Starting backfill for wallet: ${walletAddress}`);
  console.log(`   Time range: last ${hoursBack} hours\n`);

  // 1. Verify wallet exists
  const wallet = await smartWalletRepo.findByAddress(walletAddress);
  if (!wallet) {
    console.error(`❌ Wallet not found in database: ${walletAddress}`);
    console.error(`   Please add the wallet first using the API or dashboard`);
    process.exit(1);
  }
  console.log(`✅ Found wallet: ${wallet.label || wallet.address} (ID: ${wallet.id})\n`);

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
  console.log(`   To: ${new Date(now).toLocaleString()}`);
  console.log(`   Unix timestamp: ${startTimeSec} - ${Math.floor(now / 1000)}\n`);

  try {
    const walletPubkey = new PublicKey(walletAddress);
    
    // Get signatures for this wallet
    // Note: getSignaturesForAddress has limit of 1000, so we need to paginate
    let before: string | undefined = undefined;
    let processed = 0;
    let saved = 0;
    let skipped = 0;
    let errors = 0;
    let alreadyExists = 0;

    console.log(`🔍 Fetching transactions...\n`);

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
        console.log(`   No more signatures found`);
        break;
      }

      // Filter by time - only process transactions within our time range
      const relevantSigs = signatures.filter(sig => {
        if (!sig.blockTime) return false;
        const sigTime = sig.blockTime * 1000;
        return sigTime >= startTime && sigTime <= now;
      });

      console.log(`   Fetched ${signatures.length} signatures, ${relevantSigs.length} in time range`);

      // If no relevant signatures in this batch, check if we should continue
      if (relevantSigs.length === 0) {
        // If oldest signature is before our time range, we're done
        const oldestSig = signatures[signatures.length - 1];
        if (oldestSig.blockTime && oldestSig.blockTime < startTimeSec) {
          console.log(`   Oldest signature (${new Date(oldestSig.blockTime * 1000).toLocaleString()}) is before time range, stopping`);
          break;
        }
        // Otherwise continue to next page
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
            alreadyExists++;
            if (alreadyExists % 50 === 0) {
              console.log(`   ⏭️  ${alreadyExists} already exist in DB`);
            }
            continue;
          }

          // Fetch full transaction
          const tx = await connection.getTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });

          if (!tx) {
            skipped++;
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
            tx.blockTime
          );

          processed++;
          if (result.saved) {
            saved++;
            const timestamp = sigInfo.blockTime ? new Date(sigInfo.blockTime * 1000).toLocaleString() : 'N/A';
            console.log(`   ✅ [${saved}] Saved: ${sigInfo.signature.substring(0, 16)}... (${timestamp})`);
          } else {
            skipped++;
            // Log skip reasons occasionally
            if (skipped % 20 === 0) {
              console.log(`   ⏭️  Skipped ${skipped} (last reason: ${result.reason || 'unknown'})`);
            }
          }

          // Rate limiting - be nice to QuickNode
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error: any) {
          errors++;
          console.warn(`   ⚠️  Error processing ${sigInfo.signature.substring(0, 16)}...: ${error.message}`);
          if (errors > 10) {
            console.error(`   ❌ Too many errors, stopping`);
            break;
          }
        }
      }

      // Check if we need to continue
      if (signatures.length < 1000) {
        console.log(`   Reached end of signatures`);
        break;
      }

      // If oldest signature is before our time range, we're done
      const oldestSig = signatures[signatures.length - 1];
      if (oldestSig.blockTime && oldestSig.blockTime < startTimeSec) {
        console.log(`   Oldest signature (${new Date(oldestSig.blockTime * 1000).toLocaleString()}) is before time range, stopping`);
        break;
      }

      before = signatures[signatures.length - 1].signature;
      
      // Progress update
      console.log(`\n   📊 Progress: ${processed} processed, ${saved} saved, ${skipped} skipped, ${alreadyExists} already exist\n`);
    }

    console.log(`\n✅ Backfill complete!`);
    console.log(`   Processed: ${processed}`);
    console.log(`   Saved: ${saved}`);
    console.log(`   Skipped: ${skipped}`);
    console.log(`   Already existed: ${alreadyExists}`);
    console.log(`   Errors: ${errors}\n`);
  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    if (error.stack) {
      console.error(`   Stack: ${error.stack.split('\n').slice(0, 5).join('\n')}`);
    }
    process.exit(1);
  }
}

// Run script
const walletAddress = process.argv[2];
const hoursBack = parseInt(process.argv[3]) || 24;

if (!walletAddress) {
  console.error('Usage: pnpm backfill-wallet-trades <walletAddress> [hoursBack]');
  console.error('Example: pnpm backfill-wallet-trades 2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f 24');
  process.exit(1);
}

backfillWalletTrades(walletAddress, hoursBack).catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

