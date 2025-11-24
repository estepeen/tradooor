/**
 * Script to fix TYPE and POSITION for a specific wallet
 * Usage: pnpm fix:wallet-types-positions <walletAddress>
 */

import 'dotenv/config';
import { TradeRepository } from '../repositories/trade.repository.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { WalletProcessingQueueRepository } from '../repositories/wallet-processing-queue.repository.js';

const WALLET_ADDRESS = process.argv[2];

if (!WALLET_ADDRESS) {
  console.error('❌ Usage: pnpm fix:wallet-types-positions <walletAddress>');
  process.exit(1);
}

const tradeRepo = new TradeRepository();
const smartWalletRepo = new SmartWalletRepository();
const walletQueueRepo = new WalletProcessingQueueRepository();

async function fixWalletTypesAndPositions() {
  console.log(`🔄 Fixing TYPE and POSITION for wallet: ${WALLET_ADDRESS}\n`);

  try {
    // 1. Find wallet
    const wallet = await smartWalletRepo.findByAddress(WALLET_ADDRESS);
    if (!wallet) {
      console.error(`❌ Wallet not found: ${WALLET_ADDRESS}`);
      process.exit(1);
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

      for (const trade of tokenTrades) {
        const normalizedBalanceBefore = Math.abs(balanceBefore) < 0.000001 ? 0 : balanceBefore;
        
        // Determine if this is a buy or sell based on original side
        const originalSide = trade.side;
        const isBuy = originalSide === 'buy' || originalSide === 'add';
        const balanceAfter = isBuy 
          ? balanceBefore + Number(trade.amountToken)
          : Math.max(0, balanceBefore - Number(trade.amountToken));
        const normalizedBalanceAfter = Math.abs(balanceAfter) < 0.000001 ? 0 : balanceAfter;

        // Determine correct TYPE
        let newType: 'buy' | 'sell' | 'add' | 'remove';
        if (isBuy) {
          if (normalizedBalanceBefore === 0) {
            newType = 'buy';
          } else {
            newType = 'add';
          }
        } else {
          // Use tolerance for rounding
          const EPS = 0.000001;
          if (normalizedBalanceAfter < EPS) {
            newType = 'sell';
          } else {
            newType = 'remove';
          }
        }

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
            positionChangePercent,
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

    console.log(`\n✅ Fix completed!`);
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
    process.exit(1);
  }
}

fixWalletTypesAndPositions()
  .then(() => {
    console.log('\n✅ Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Script failed:', error);
    process.exit(1);
  });

