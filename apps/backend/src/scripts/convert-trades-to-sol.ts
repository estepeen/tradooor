/**
 * Convert all trades for a wallet from USDC/USDT to SOL
 * 
 * Usage: pnpm --filter backend convert:trades-to-sol <WALLET_ADDRESS>
 */

import { prisma } from '../lib/prisma.js';
import { BinancePriceService } from '../services/binance-price.service.js';
import { safeDecimalToNumber } from '../lib/prisma.js';

async function convertTradesToSol(walletAddress: string) {
  console.log(`🔄 Converting trades to SOL for wallet: ${walletAddress}\n`);

  // Find wallet by address
  const wallet = await prisma.smartWallet.findUnique({
    where: { address: walletAddress },
    select: {
      id: true,
      address: true,
      label: true,
    },
  });

  if (!wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }

  console.log(`✅ Found wallet: ${wallet.label || wallet.address}`);
  console.log(`   Wallet ID: ${wallet.id}\n`);

  // Get all trades for this wallet
  const trades = await prisma.trade.findMany({
    where: {
      walletId: wallet.id,
      side: { not: 'void' }, // Skip void trades
    },
    orderBy: {
      timestamp: 'asc',
    },
  });

  console.log(`📦 Found ${trades.length} trades to process\n`);

  if (trades.length === 0) {
    console.log('✅ No trades to convert');
    process.exit(0);
  }

  const binancePriceService = new BinancePriceService();
  let convertedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    const meta = (trade.meta as any) || {};
    const baseToken = (meta.baseToken || 'SOL').toUpperCase();
    
    // Skip if already in SOL
    if (baseToken === 'SOL' || baseToken === 'WSOL') {
      skippedCount++;
      continue;
    }

    // Only convert USDC/USDT
    if (baseToken !== 'USDC' && baseToken !== 'USDT') {
      skippedCount++;
      continue;
    }

    try {
      const amountBase = safeDecimalToNumber(trade.amountBase);
      const priceBasePerToken = safeDecimalToNumber(trade.priceBasePerToken);
      const tradeTimestamp = new Date(trade.timestamp);

      // Get SOL price at the time of the trade
      const solPriceUsd = await binancePriceService.getSolPriceAtTimestamp(tradeTimestamp);
      
      if (!solPriceUsd || solPriceUsd <= 0) {
        console.warn(`   ⚠️  [${i + 1}/${trades.length}] ${trade.txSignature.substring(0, 16)}... - No SOL price available`);
        errorCount++;
        continue;
      }

      // Convert amountBase from USDC/USDT to SOL
      // USDC/USDT amount / SOL price = SOL amount
      const amountBaseSol = amountBase / solPriceUsd;
      
      // Convert priceBasePerToken from USDC/USDT to SOL
      // priceBasePerToken (USD) / SOL price = priceBasePerToken (SOL)
      const priceBasePerTokenSol = priceBasePerToken / solPriceUsd;

      // Update trade in database
      await prisma.trade.update({
        where: { id: trade.id },
        data: {
          amountBase: amountBaseSol,
          priceBasePerToken: priceBasePerTokenSol,
          meta: {
            ...meta,
            baseToken: 'SOL', // Update baseToken to SOL
            originalBaseToken: baseToken, // Keep original for reference
            convertedToSol: true,
            conversionTimestamp: new Date().toISOString(),
            solPriceUsdAtTrade: solPriceUsd,
          },
        },
      });

      convertedCount++;
      
      if ((i + 1) % 100 === 0) {
        console.log(`   ✅ Processed ${i + 1}/${trades.length} trades (${convertedCount} converted, ${skippedCount} skipped, ${errorCount} errors)`);
      }
    } catch (error: any) {
      console.error(`   ❌ [${i + 1}/${trades.length}] Error converting trade ${trade.txSignature.substring(0, 16)}...: ${error.message}`);
      errorCount++;
    }
  }

  console.log(`\n✅ Conversion completed!`);
  console.log(`   Total trades: ${trades.length}`);
  console.log(`   Converted: ${convertedCount}`);
  console.log(`   Skipped (already SOL): ${skippedCount}`);
  console.log(`   Errors: ${errorCount}\n`);

  // Recalculate wallet metrics after conversion
  console.log(`🔄 Recalculating wallet metrics...`);
  try {
    const { MetricsCalculatorService } = await import('../services/metrics-calculator.service.js');
    const { SmartWalletRepository } = await import('../repositories/smart-wallet.repository.js');
    const { TradeRepository } = await import('../repositories/trade.repository.js');
    const { MetricsHistoryRepository } = await import('../repositories/metrics-history.repository.js');
    const { LotMatchingService } = await import('../services/lot-matching.service.js');

    const smartWalletRepo = new SmartWalletRepository();
    const tradeRepo = new TradeRepository();
    const metricsHistoryRepo = new MetricsHistoryRepository();
    const metricsCalculator = new MetricsCalculatorService(
      smartWalletRepo,
      tradeRepo,
      metricsHistoryRepo
    );
    const lotMatchingService = new LotMatchingService();

    // Recreate closed lots with new SOL values
    console.log(`   📊 Processing trades for lot matching...`);
    await lotMatchingService.processTradesForWallet(wallet.id);
    
    // Recalculate metrics
    console.log(`   📊 Calculating metrics...`);
    await metricsCalculator.calculateMetricsForWallet(wallet.id);
    
    console.log(`   ✅ Metrics recalculated\n`);
  } catch (error: any) {
    console.error(`   ❌ Error recalculating metrics: ${error.message}`);
  }
}

const walletAddress = process.argv[2];
if (!walletAddress) {
  console.error('Usage: tsx convert-trades-to-sol.ts <WALLET_ADDRESS>');
  process.exit(1);
}

convertTradesToSol(walletAddress)
  .then(() => {
    console.log('✅ Done');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });

