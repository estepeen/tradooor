import dotenv from 'dotenv';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { PumpfunStreamService } from '../services/pumpfun-stream.service.js';

dotenv.config();

/**
 * Worker script pro Pump.fun WebSocket stream
 * 
 * Spustí realtime tracking Pump.fun trades pro všechny smart wallets.
 * 
 * Použití:
 *   pnpm --filter backend pumpfun:stream
 */
async function main() {
  // Global kill-switch: do not run unless explicitly enabled
  const trackingEnabled =
    process.env.TRACKING_ENABLED === 'true' ||
    process.env.PUMPFUN_STREAM_ENABLED === 'true';
  if (!trackingEnabled) {
    console.log('🛑 Pump.fun stream disabled. Set TRACKING_ENABLED=true (or PUMPFUN_STREAM_ENABLED=true) to run.');
    process.exit(0);
  }

  const smartWalletRepo = new SmartWalletRepository();
  const tradeRepo = new TradeRepository();
  const tokenRepo = new TokenRepository();
  const streamService = new PumpfunStreamService(
    smartWalletRepo,
    tradeRepo,
    tokenRepo
  );

  try {
    console.log('🚀 Starting Pump.fun WebSocket stream...');
    await streamService.start();

    // Keep process running
    process.on('SIGINT', async () => {
      console.log('\n🛑 Shutting down Pump.fun stream...');
      streamService.stop();
      process.exit(0);
    });

    // Keep alive
    setInterval(() => {
      // Heartbeat
    }, 60000);

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();

