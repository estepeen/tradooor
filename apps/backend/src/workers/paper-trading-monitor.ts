/**
 * Paper Trading Monitor Worker
 * 
 * Monitoruje nové trades a kopíruje je jako paper trades
 * 
 * Usage:
 *   pnpm --filter backend paper-trading:monitor
 * 
 * Environment variables:
 *   PAPER_TRADING_ENABLED=true
 *   PAPER_TRADING_COPY_ALL=true
 *   PAPER_TRADING_MIN_SCORE=70
 *   PAPER_TRADING_POSITION_SIZE_PERCENT=5
 *   PAPER_TRADING_MAX_POSITION_SIZE_USD=1000
 *   PAPER_TRADING_MAX_OPEN_POSITIONS=10
 */

import { supabase, TABLES } from '../lib/supabase.js';
import { PaperTradeService, PaperTradingConfig } from '../services/paper-trade.service.js';
import { PaperTradingModelsService } from '../services/paper-trading-models.service.js';
import { SignalService } from '../services/signal.service.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { PaperTradeRepository } from '../repositories/paper-trade.repository.js';

const PAPER_TRADING_ENABLED = process.env.PAPER_TRADING_ENABLED === 'true';
const PAPER_TRADING_COPY_ALL = process.env.PAPER_TRADING_COPY_ALL !== 'false'; // Default: true
const PAPER_TRADING_MIN_SCORE = process.env.PAPER_TRADING_MIN_SCORE ? Number(process.env.PAPER_TRADING_MIN_SCORE) : undefined;
const PAPER_TRADING_POSITION_SIZE_PERCENT = process.env.PAPER_TRADING_POSITION_SIZE_PERCENT ? Number(process.env.PAPER_TRADING_POSITION_SIZE_PERCENT) : 5;
const PAPER_TRADING_MAX_POSITION_SIZE_USD = process.env.PAPER_TRADING_MAX_POSITION_SIZE_USD ? Number(process.env.PAPER_TRADING_MAX_POSITION_SIZE_USD) : undefined;
const PAPER_TRADING_MAX_OPEN_POSITIONS = process.env.PAPER_TRADING_MAX_OPEN_POSITIONS ? Number(process.env.PAPER_TRADING_MAX_OPEN_POSITIONS) : 10;

const CHECK_INTERVAL_MS = 300000; // Check every 5 minutes (reduced from 30s to lower CPU usage)

async function monitorTrades() {
  if (!PAPER_TRADING_ENABLED) {
    console.log('⏸️  Paper trading is disabled (PAPER_TRADING_ENABLED=false)');
    return;
  }

  console.log('\n🔄 Starting Paper Trading Monitor...\n');
  console.log('Configuration:');
  console.log(`  Copy All Trades: ${PAPER_TRADING_COPY_ALL}`);
  console.log(`  Min Wallet Score: ${PAPER_TRADING_MIN_SCORE || 'none'}`);
  console.log(`  Position Size: ${PAPER_TRADING_POSITION_SIZE_PERCENT}%`);
  console.log(`  Max Position Size: ${PAPER_TRADING_MAX_POSITION_SIZE_USD ? `$${PAPER_TRADING_MAX_POSITION_SIZE_USD}` : 'unlimited'}`);
  console.log(`  Max Open Positions: ${PAPER_TRADING_MAX_OPEN_POSITIONS}\n`);

  const paperTradeService = new PaperTradeService();
  const paperTradingModels = new PaperTradingModelsService();
  const signalService = new SignalService();
  const paperTradeRepo = new PaperTradeRepository();
  const tradeRepo = new TradeRepository();

  const config: PaperTradingConfig = {
    enabled: true,
    copyAllTrades: PAPER_TRADING_COPY_ALL,
    minWalletScore: PAPER_TRADING_MIN_SCORE,
    positionSizePercent: PAPER_TRADING_POSITION_SIZE_PERCENT,
    maxPositionSizeUsd: PAPER_TRADING_MAX_POSITION_SIZE_USD,
    maxOpenPositions: PAPER_TRADING_MAX_OPEN_POSITIONS,
  };

  let lastCheckedTimestamp = new Date(Date.now() - 60000); // Start from 1 minute ago

  async function checkNewTrades() {
    try {
      // DŮLEŽITÉ: Paper trading se nyní zpracovává přímo z webhooku (ConsensusWebhookService)
      // Worker už nekopíruje trades - jen kontroluje stop losses a expiruje signály
      
      console.log('📊 Paper trading monitor: Checking stop losses and expiring signals (trades are processed from webhook)');

      // 5. Expiruj staré signály (starší než 24h)
      try {
        const expiredCount = await signalService.expireOldSignals(24);
        if (expiredCount > 0) {
          console.log(`⏰ Expired ${expiredCount} old signals`);
        }
      } catch (error: any) {
        console.error('❌ Error expiring old signals:', error.message);
      }

      // 6. Zkontroluj stop losses (50% ztráta = automatický prodej)
      try {
        const stopLossClosed = await paperTradeService.checkStopLosses();
        if (stopLossClosed > 0) {
          console.log(`🛑 Closed ${stopLossClosed} positions due to stop loss (50% loss)`);
        }
      } catch (error: any) {
        console.error('❌ Error checking stop losses:', error.message);
      }

      // 7. Aktualizuj timestamp
      lastCheckedTimestamp = new Date();

      // 8. Vytvoř portfolio snapshot (každých 5 minut)
      const now = Date.now();
      const lastSnapshotTime = (monitorTrades as any).lastSnapshotTime || 0;
      if (!lastSnapshotTime || now - lastSnapshotTime > 5 * 60 * 1000) {
        try {
          await paperTradeService.createPortfolioSnapshot();
          (monitorTrades as any).lastSnapshotTime = now;
          console.log('📸 Portfolio snapshot created');
        } catch (error: any) {
          console.error('❌ Error creating portfolio snapshot:', error.message);
        }
      }

      // 9. Zobraz portfolio stats
      const stats = await paperTradeService.getPortfolioStats();
      console.log(`\n📊 Portfolio Stats:`);
      console.log(`   Total Value: $${stats.totalValueUsd.toFixed(2)}`);
      console.log(`   Total Cost: $${stats.totalCostUsd.toFixed(2)}`);
      console.log(`   Total PnL: $${stats.totalPnlUsd.toFixed(2)} (${stats.totalPnlPercent.toFixed(2)}%)`);
      console.log(`   Open Positions: ${stats.openPositions}`);
      console.log(`   Closed Positions: ${stats.closedPositions}`);
      console.log(`   Win Rate: ${stats.winRate ? (stats.winRate * 100).toFixed(2) + '%' : 'N/A'}\n`);

    } catch (error: any) {
      console.error('❌ Error in checkNewTrades:', error.message);
    }
  }

  // Spusť první kontrolu hned
  await checkNewTrades();

  // Pak kontroluj každých CHECK_INTERVAL_MS
  const interval = setInterval(checkNewTrades, CHECK_INTERVAL_MS);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Stopping Paper Trading Monitor...');
    clearInterval(interval);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n🛑 Stopping Paper Trading Monitor...');
    clearInterval(interval);
    process.exit(0);
  });
}

// Store last snapshot time
(monitorTrades as any).lastSnapshotTime = null;

// Spusť monitor
if (import.meta.url === `file://${process.argv[1]}`) {
  monitorTrades().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { monitorTrades };
