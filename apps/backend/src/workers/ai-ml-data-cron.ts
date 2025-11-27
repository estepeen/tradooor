import 'dotenv/config';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TradeSequenceRepository } from '../repositories/trade-sequence.repository.js';
import { TradeOutcomeRepository } from '../repositories/trade-outcome.repository.js';
import { TradeFeatureRepository } from '../repositories/trade-feature.repository.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TokenPriceService } from '../services/token-price.service.js';
import { BinancePriceService } from '../services/binance-price.service.js';
import { AiMlDataService } from '../services/ai-ml-data.service.js';
import { TraderCharacterizationService } from '../services/trader-characterization.service.js';
import { supabase, TABLES } from '../lib/supabase.js';
import cron from 'node-cron';

/**
 * Worker pro výpočet AI/ML dat (sequence patterns, outcomes, market context)
 * SEPAROVÁNO od současných fungujících věcí - pouze pro AI/ML trénink
 * 
 * Spouští se periodicky a vypočítává:
 * - TradeSequence data (pořadí tradeů, time between trades, patterns)
 * - TradeOutcome data (win/loss labels, token outcomes)
 * - Market context features (price momentum, volume spikes)
 */
async function processWallet(walletId: string) {
  try {
    const tradeRepo = new TradeRepository();
    const tradeSequenceRepo = new TradeSequenceRepository();
    const tradeOutcomeRepo = new TradeOutcomeRepository();
    const tradeFeatureRepo = new TradeFeatureRepository();
    const smartWalletRepo = new SmartWalletRepository();
    const tokenPriceService = new TokenPriceService();
    const binancePriceService = new BinancePriceService();

    const traderCharacterizationService = new TraderCharacterizationService(
      tradeRepo,
      tradeFeatureRepo,
      tradeOutcomeRepo,
      smartWalletRepo
    );

    const aiMlDataService = new AiMlDataService(
      tradeRepo,
      tradeSequenceRepo,
      tradeOutcomeRepo,
      tradeFeatureRepo,
      tokenPriceService,
      binancePriceService,
      traderCharacterizationService
    );

    // Načti všechny trades pro walletku
    const allTrades = await tradeRepo.findAllForMetrics(walletId);
    
    console.log(`📊 Processing ${allTrades.length} trades for wallet ${walletId}`);

    // Pro každý trade vypočti AI/ML data
    for (const trade of allTrades) {
      try {
        await aiMlDataService.calculateAllAiMlData(trade.id, walletId);
      } catch (error: any) {
        console.error(`❌ Failed to process trade ${trade.id}:`, error.message);
        // Pokračuj s dalšími trades
      }
    }

    // Vypočti behavior profile pro tradera
    try {
      await traderCharacterizationService.calculateBehaviorProfile(walletId);
      console.log(`✅ Calculated behavior profile for wallet ${walletId}`);
    } catch (error: any) {
      console.error(`❌ Failed to calculate behavior profile for wallet ${walletId}:`, error.message);
    }

    console.log(`✅ Completed processing wallet ${walletId}`);
  } catch (error: any) {
    console.error(`❌ Error processing wallet ${walletId}:`, error.message);
    throw error;
  }
}

async function main() {
  console.log('🤖 AI/ML Data Worker starting...');

  // Default: každou hodinu (0 * * * *)
  // Můžeš změnit přes environment variable AI_ML_CRON_SCHEDULE
  const cronSchedule = process.env.AI_ML_CRON_SCHEDULE || '0 * * * *';

  console.log(`⏰ Cron schedule: ${cronSchedule}`);

  // Spusť okamžitě při startu (pro testování)
  if (process.env.AI_ML_RUN_ON_START === 'true') {
    console.log('🚀 Running immediately on start...');
    await runOnce();
  }

  // Nastav cron job
  cron.schedule(cronSchedule, async () => {
    console.log(`⏰ Cron triggered at ${new Date().toISOString()}`);
    await runOnce();
  });

  console.log('✅ AI/ML Data Worker started');
}

async function runOnce() {
  try {
    // Načti všechny walletky
    const { data: wallets, error } = await supabase
      .from(TABLES.SMART_WALLET)
      .select('id')
      .order('updatedAt', { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch wallets: ${error.message}`);
    }

    if (!wallets || wallets.length === 0) {
      console.log('⚠️  No wallets found');
      return;
    }

    console.log(`📋 Processing ${wallets.length} wallets`);

    // Pro každou walletku vypočti AI/ML data
    for (const wallet of wallets) {
      try {
        await processWallet(wallet.id);
      } catch (error: any) {
        console.error(`❌ Failed to process wallet ${wallet.id}:`, error.message);
        // Pokračuj s dalšími walletkami
      }
    }

    console.log('✅ AI/ML data calculation completed');
  } catch (error: any) {
    console.error('❌ Error in AI/ML data calculation:', error.message);
    process.exit(1);
  }
}

// Spusť pokud je skript volán přímo
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { main, runOnce };

