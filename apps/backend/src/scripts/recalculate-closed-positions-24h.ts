/**
 * Recalculate Closed Positions for All Wallets (Last 24h)
 * 
 * Přepočítá closed positions pro všechny wallets za posledních 24 hodin.
 * Spouští se jednou denně, aby se aktualizovaly closed positions u wallets,
 * kde se neaktualizují automaticky.
 * 
 * Usage: pnpm --filter backend recalculate:closed-positions-24h
 */

import 'dotenv/config';
import { prisma } from '../lib/prisma.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { LotMatchingService } from '../services/lot-matching.service.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';

async function recalculateClosedPositions24h() {
  console.log('🔄 Starting closed positions recalculation for last 24h...\n');

  const smartWalletRepo = new SmartWalletRepository();
  const tradeRepo = new TradeRepository();
  const metricsHistoryRepo = new MetricsHistoryRepository();
  const metricsCalculator = new MetricsCalculatorService(
    smartWalletRepo,
    tradeRepo,
    metricsHistoryRepo
  );
  const lotMatchingService = new LotMatchingService();

  try {
    // 1. Najdi všechny wallets
    const walletList = await prisma.smartWallet.findMany({
      select: {
        id: true,
        address: true,
        createdAt: true,
      },
    });
    console.log(`📊 Found ${walletList.length} wallets to process\n`);

    let successCount = 0;
    let errorCount = 0;
    let updatedCount = 0;

    // 2. Pro každou wallet přepočti closed positions za posledních 24h
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    for (const wallet of walletList) {
      try {
        console.log(`  Processing wallet: ${wallet.address.substring(0, 8)}...`);

        // 3. Zkontroluj, jestli má wallet trades za posledních 24h
        const recentTrades = await prisma.trade.findMany({
          where: {
            walletId: wallet.id,
            timestamp: { gte: last24h },
            side: { not: 'void' },
          },
          select: {
            id: true,
          },
          take: 1,
        });

        if (!recentTrades || recentTrades.length === 0) {
          console.log(`    ⏭️  No trades in last 24h, skipping`);
          continue;
        }

        console.log(`    📊 Wallet has trades in last 24h, recalculating closed positions...`);

        // 4. Přepočti closed lots pro všechny tokeny této wallet
        // (closed lots se mohou změnit i když nový trade není, pokud se přepočítají staré trades)
        const walletData = await smartWalletRepo.findById(wallet.id);
        const trackingStartTime = walletData?.createdAt ? new Date(walletData.createdAt) : undefined;

        try {
          // Přepočti closed lots pro všechny tokeny
          const closedLots = await lotMatchingService.processTradesForWallet(
            wallet.id,
            undefined, // Process all tokens
            trackingStartTime
          );

          if (closedLots.length > 0) {
            // Ulož closed lots (přepíše existující)
            await lotMatchingService.saveClosedLots(closedLots);
            console.log(`    ✅ Updated ${closedLots.length} closed lots`);
          } else {
            console.log(`    ⏭️  No closed lots found`);
          }

          // 5. Přepočti metriky pro tuto wallet (aby se aktualizovaly closed positions v statistikách)
          await metricsCalculator.calculateMetricsForWallet(wallet.id);
          console.log(`    ✅ Metrics recalculated`);
          updatedCount++;
        } catch (processError: any) {
          console.warn(`    ⚠️  Error processing wallet: ${processError.message}`);
          throw processError;
        }

        successCount++;
      } catch (error: any) {
        console.error(`  ❌ Error processing wallet ${wallet.address.substring(0, 8)}...:`, error.message);
        errorCount++;
      }
    }

    console.log(`\n✅ Recalculation complete!`);
    console.log(`   Processed: ${successCount} wallets`);
    console.log(`   Updated: ${updatedCount} wallets with closed positions`);
    console.log(`   Errors: ${errorCount} wallets`);
  } catch (error: any) {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  recalculateClosedPositions24h();
}

export { recalculateClosedPositions24h };
