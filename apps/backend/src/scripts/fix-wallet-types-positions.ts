/**
 * Script to fix TYPE values for trades so that only BUY/SELL remain.
 * Usage:
 *   pnpm fix:wallet-types-positions <walletAddress>
 *   pnpm fix:wallet-types-positions --all
 */

import 'dotenv/config';
import { TradeRepository } from '../repositories/trade.repository.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { WalletProcessingQueueRepository } from '../repositories/wallet-processing-queue.repository.js';

const TARGET_ARG = process.argv[2];

if (!TARGET_ARG) {
  console.error('❌ Usage: pnpm fix:wallet-types-positions <walletAddress> | --all');
  process.exit(1);
}

const tradeRepo = new TradeRepository();
const smartWalletRepo = new SmartWalletRepository();
const walletQueueRepo = new WalletProcessingQueueRepository();

async function processWallet(address: string) {
  console.log(`\n🔄 Fixing TYPE for wallet: ${address}\n`);

  try {
    // 1. Find wallet
    const wallet = await smartWalletRepo.findByAddress(address);
    if (!wallet) {
      console.error(`❌ Wallet not found: ${address}`);
      return;
    }

    console.log(`✅ Found wallet: ${wallet.id}\n`);

    // 2. Get all trades for this wallet
    const allTrades = await tradeRepo.findAllForMetrics(wallet.id);
    console.log(`📊 Found ${allTrades.length} trades\n`);

    if (allTrades.length === 0) {
      console.log('⏭️  No trades found, nothing to fix');
      return;
    }

    // 3. Group trades by tokenId
    const tradesByToken = new Map<string, typeof allTrades>();
    for (const trade of allTrades) {
      const tokenId = trade.tokenId;
      if (!tradesByToken.has(tokenId)) {
        tradesByToken.set(tokenId, []);
      }
      tradesByToken.get(tokenId)!.push(trade);
    }

    let totalUpdated = 0;
    let totalSkipped = 0;

    // 4. Process each token's trades in chronological order
    for (const [tokenId, tokenTrades] of tradesByToken.entries()) {
      // Sort by timestamp (ascending)
      tokenTrades.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      let balanceBefore = 0;

      for (let i = 0; i < tokenTrades.length; i++) {
        const trade = tokenTrades[i];
        const normalizedBalanceBefore = Math.abs(balanceBefore) < 0.000001 ? 0 : balanceBefore;
        
        // Determine if this is a buy or sell based on original side
        const originalSide = trade.side;
        const isBuy = originalSide === 'buy' || originalSide === 'add';
        const balanceAfter = isBuy 
          ? balanceBefore + Number(trade.amountToken)
          : Math.max(0, balanceBefore - Number(trade.amountToken));
        const normalizedBalanceAfter = Math.abs(balanceAfter) < 0.000001 ? 0 : balanceAfter;

        // Get last trade for this token to prevent consecutive BUY/BUY or SELL/SELL
        const lastTrade = i > 0 ? tokenTrades[i - 1] : null;
        const lastSide = lastTrade?.side || null;

        // Determine correct TYPE with new logic to prevent consecutive BUY/BUY or SELL/SELL
        let newType: 'buy' | 'sell';
        newType = isBuy ? 'buy' : 'sell';

        // Calculate positionChangePercent
        let positionChangePercent: number | undefined = undefined;

        if (isBuy) {
          if (normalizedBalanceBefore === 0) {
            positionChangePercent = 100;
          } else {
            positionChangePercent = (Number(trade.amountToken) / balanceBefore) * 100;
            if (positionChangePercent > 1000) {
              positionChangePercent = 100;
            }
          }
        } else {
          if (normalizedBalanceBefore === 0) {
            positionChangePercent = 0;
          } else if (normalizedBalanceAfter === 0) {
            positionChangePercent = -100;
          } else {
            positionChangePercent = -(Number(trade.amountToken) / balanceBefore) * 100;
            if (positionChangePercent < -100) {
              positionChangePercent = -100;
            }
            if (Math.abs(positionChangePercent) > 1000) {
              positionChangePercent = -100;
            }
          }
        }

        // Update trade if TYPE or positionChangePercent changed
        const needsUpdate = 
          trade.side !== newType || 
          Math.abs(Number(trade.positionChangePercent || 0) - (positionChangePercent || 0)) > 0.01;

        if (needsUpdate) {
          await tradeRepo.update(trade.id, {
            side: newType,
          });
          totalUpdated++;
          console.log(`  ✅ Updated trade ${trade.txSignature.substring(0, 16)}...: ${trade.side} → ${newType}, position: ${positionChangePercent?.toFixed(2)}%`);
        } else {
          totalSkipped++;
        }

        // Update balance for next iteration
        balanceBefore = balanceAfter;
      }
    }

    console.log(`\n✅ Fix completed for wallet ${address}!`);
    console.log(`   Updated: ${totalUpdated} trades`);
    console.log(`   Skipped: ${totalSkipped} trades (no changes needed)`);

    // 5. Enqueue wallet for metrics recalculation
    try {
      await walletQueueRepo.enqueue(wallet.id);
      console.log(`\n✅ Enqueued wallet ${wallet.address} for metrics recalculation.`);
    } catch (queueError: any) {
      console.warn(`⚠️  Failed to enqueue wallet for metrics recalculation: ${queueError.message}`);
    }

  } catch (error: any) {
    console.error('❌ Error fixing wallet:', error);
  }
}

async function processAllWallets() {
  console.log('🔄 Running fix for ALL wallets...\n');

  const pageSize = 200;
  let page = 1;
  let processed = 0;

  while (true) {
    const { wallets, total } = await smartWalletRepo.findAll({ page, pageSize });
    const batch = wallets || [];

    if (!batch.length) {
      break;
    }

    for (const wallet of batch) {
      if (!wallet.address) continue;
      await processWallet(wallet.address);
      processed++;
    }

    if (processed >= (total ?? 0)) {
      break;
    }

    page++;
  }

  console.log(`\n✅ Completed fix for ${processed} wallets`);
}

(async () => {
  if (TARGET_ARG === '--all') {
    await processAllWallets();
  } else {
    await processWallet(TARGET_ARG);
  }

    console.log('\n✅ Script completed successfully');
    process.exit(0);
})().catch((error) => {
    console.error('❌ Script failed:', error);
    process.exit(1);
  });
