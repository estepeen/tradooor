import 'dotenv/config';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { supabase } from '../lib/supabase.js';

const smartWalletRepo = new SmartWalletRepository();
const tradeRepo = new TradeRepository();

/**
 * Recalculate portfolio cache (open and closed positions) for all wallets
 * This script updates the PortfolioBaseline cache for all wallets by calling
 * the portfolio endpoint logic (simplified version)
 */
async function recalculateAllPortfolioCache() {
  console.log(`\n🔄 Recalculating portfolio cache for all wallets...\n`);

  // Get API base URL
  const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001';
  
  // 1. Get all wallets
  const allWallets = await smartWalletRepo.findAll({ page: 1, pageSize: 10000 });
  console.log(`📋 Found ${allWallets.wallets.length} wallets\n`);

  let totalProcessed = 0;
  let totalErrors = 0;

  // 2. Process each wallet
  for (const wallet of allWallets.wallets) {
    try {
      // Check if wallet has trades
      const { total } = await tradeRepo.findByWalletId(wallet.id, { pageSize: 1 });
      if (total === 0) {
        continue; // Skip wallets without trades
      }

      console.log(`\n[${totalProcessed + 1}/${allWallets.wallets.length}] 🔍 Processing wallet: ${wallet.label || wallet.address} (${wallet.address.substring(0, 8)}...)`);
      console.log(`   Trades: ${total}`);

      // Call portfolio endpoint with forceRefresh=true
      try {
        const response = await fetch(`${API_BASE_URL}/api/smart-wallets/${wallet.id}/portfolio?forceRefresh=true`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const portfolioData = await response.json();
        const openCount = portfolioData.openPositions?.length || 0;
        const closedCount = portfolioData.closedPositions?.length || 0;
        
        console.log(`   ✅ Portfolio cache updated: ${openCount} open positions, ${closedCount} closed positions`);
        totalProcessed++;
      } catch (fetchError: any) {
        // If API is not available, try to calculate portfolio directly
        console.log(`   ⚠️  API call failed (${fetchError.message}), skipping...`);
        // Continue to next wallet
        continue;
      }

    } catch (error: any) {
      totalErrors++;
      console.error(`   ❌ Error processing wallet ${wallet.address}: ${error.message}`);
    }
  }

  console.log(`\n✅ Portfolio cache recalculation complete!`);
  console.log(`   Processed wallets: ${totalProcessed}`);
  console.log(`   Errors: ${totalErrors}\n`);
}

recalculateAllPortfolioCache().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
