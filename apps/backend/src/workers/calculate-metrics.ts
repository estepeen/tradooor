import dotenv from 'dotenv';
import { supabase, TABLES } from '../lib/supabase.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';

dotenv.config();

async function main() {
  const walletId = process.argv[2]; // Optional: calculate for specific wallet

  const smartWalletRepo = new SmartWalletRepository();
  const tradeRepo = new TradeRepository();
  const metricsHistoryRepo = new MetricsHistoryRepository();
  const metricsCalculator = new MetricsCalculatorService(
    smartWalletRepo,
    tradeRepo,
    metricsHistoryRepo
  );

  try {
    if (walletId) {
      console.log(`Calculating metrics for wallet: ${walletId}`);
      const result = await metricsCalculator.calculateMetricsForWallet(walletId);
      console.log('Metrics calculated:', result);
    } else {
      console.log('Calculating metrics for all wallets...');
      const { data: wallets, error } = await supabase
        .from(TABLES.SMART_WALLET)
        .select('id, address');

      if (error) {
        throw new Error(`Failed to fetch wallets: ${error.message}`);
      }

      for (const wallet of wallets ?? []) {
        console.log(`Processing wallet: ${wallet.address}`);
        try {
          await metricsCalculator.calculateMetricsForWallet(wallet.id);
          console.log(`✓ Completed: ${wallet.address}`);
        } catch (error) {
          console.error(`✗ Error processing ${wallet.address}:`, error);
        }
      }

      console.log(`\nCompleted processing ${wallets?.length ?? 0} wallets`);
    }
  } catch (error) {
    console.error('Error calculating metrics:', error);
    process.exit(1);
  }
}

main();
