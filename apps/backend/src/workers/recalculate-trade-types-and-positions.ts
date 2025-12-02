import 'dotenv/config';
import { TradeRepository } from '../repositories/trade.repository.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { supabase, TABLES } from '../lib/supabase.js';

const tradeRepo = new TradeRepository();
const smartWalletRepo = new SmartWalletRepository();

/**
 * Recalculate TYPE (buy/sell/add/remove) and positionChangePercent for all existing trades
 * 
 * Logic:
 * - BUY = první nákup tokenu, když se balance změní z 0 na >0
 * - ADD = každý další nákup/přikoupení, když už máme balance > 0
 * - REM = odprodej tokenů (ne nikdy 100%), když balance zůstává > 0
 * - SELL = poslední prodej tokenu, kdy balance = 0
 * 
 * Usage:
 *   pnpm --filter backend recalculate:types-positions
 */
async function recalculateTypesAndPositions() {
  console.log('🔄 Starting TYPE and POSITION recalculation for all trades...\n');

  try {
    // Get all wallets
    const { data: wallets, error: walletsError } = await supabase
      .from(TABLES.SMART_WALLET)
      .select('id, address');

    if (walletsError) {
      throw new Error(`Failed to fetch wallets: ${walletsError.message}`);
    }

    const walletList = wallets || [];
    console.log(`📊 Processing ${walletList.length} wallets...\n`);

    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (const wallet of walletList) {
      try {
        console.log(`  Processing wallet: ${wallet.address.substring(0, 8)}...`);

        // Get all trades for this wallet, sorted by timestamp
        const allTrades = await tradeRepo.findAllForMetrics(wallet.id);
        
        if (allTrades.length === 0) {
          console.log(`    ⏭️  No trades found, skipping...\n`);
          continue;
        }

        // Group trades by tokenId
        const tradesByToken = new Map<string, typeof allTrades>();
        for (const trade of allTrades) {
          const tokenId = trade.tokenId;
          if (!tradesByToken.has(tokenId)) {
            tradesByToken.set(tokenId, []);
          }
          tradesByToken.get(tokenId)!.push(trade);
        }

        // Process each token's trades in chronological order
        for (const [tokenId, tokenTrades] of tradesByToken.entries()) {
          // Sort by timestamp (ascending)
          tokenTrades.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

          let balanceBefore = 0;

          for (let i = 0; i < tokenTrades.length; i++) {
            const trade = tokenTrades[i];
            const normalizedBalanceBefore = Math.abs(balanceBefore) < 0.000001 ? 0 : balanceBefore;
            
            // Determine if this is a buy or sell based on original side (before we recalculate)
            // We need to check the original side to determine direction
            const originalSide = trade.side;
            const isBuy = originalSide === 'buy' || originalSide === 'add';
            const balanceAfter = isBuy 
              ? balanceBefore + Number(trade.amountToken)
              : Math.max(0, balanceBefore - Number(trade.amountToken));
            const normalizedBalanceAfter = Math.abs(balanceAfter) < 0.000001 ? 0 : balanceAfter;

            // Get last trade for this token to prevent consecutive BUY/BUY or SELL/SELL
            const lastTrade = i > 0 ? tokenTrades[i - 1] : null;
            const lastSide = lastTrade?.side || null;

            // Determine TYPE with new logic to prevent consecutive BUY/BUY or SELL/SELL
            let newType: 'buy' | 'sell' | 'add' | 'remove';
            if (isBuy) {
              // BUY logic: prevent consecutive BUY
              if (normalizedBalanceBefore === 0) {
                // Balance is 0 - check if last trade was also a buy
                if (lastSide === 'buy' || lastSide === 'add') {
                  // Last trade was BUY/ADD, so this must be ADD (not BUY)
                  newType = 'add';
                } else {
                  // Last trade was SELL/REMOVE or no previous trade - this is a new BUY
                  newType = 'buy';
                }
              } else {
                // Balance > 0 - this must be ADD
                newType = 'add';
              }
            } else {
              // SELL logic: prevent consecutive SELL
              const EPS = 0.000001;
              if (normalizedBalanceAfter < EPS) {
                // Balance after is 0 - check if last trade was also a sell
                if (lastSide === 'sell' || lastSide === 'remove') {
                  // Last trade was SELL/REMOVE, so this must be REMOVE (not SELL)
                  newType = 'remove';
                } else {
                  // Last trade was BUY/ADD or no previous trade - this is a new SELL
                  newType = 'sell';
                }
              } else {
                // Balance after > 0 - this must be REMOVE
                newType = 'remove';
              }
            }

            // Calculate positionChangePercent
            let positionChangePercent: number | undefined = undefined;

            if (isBuy) {
              // BUY nebo ADD
              if (normalizedBalanceBefore === 0) {
                // První nákup (BUY) - pozice se vytváří, takže 100% změna
                positionChangePercent = 100;
              } else {
                // Další nákup (ADD) - počítáme % změnu z existující pozice
                positionChangePercent = (Number(trade.amountToken) / balanceBefore) * 100;
                // Omezíme na rozumné hodnoty (max 1000%, pak ořízneme na 100%)
                if (positionChangePercent > 1000) {
                  positionChangePercent = 100;
                }
              }
            } else {
              // REM nebo SELL
              if (normalizedBalanceBefore === 0) {
                // Nemůžeme prodávat, když nemáme pozici
                positionChangePercent = 0;
              } else if (normalizedBalanceAfter === 0) {
                // SELL - prodáváme všechno, takže -100%
                positionChangePercent = -100;
              } else {
                // REM - částečný prodej, počítáme % změnu z existující pozice
                positionChangePercent = -(Number(trade.amountToken) / balanceBefore) * 100;
                // Omezíme na rozumné hodnoty (min -100%)
                if (positionChangePercent < -100) {
                  positionChangePercent = -100;
                }
                // Pokud je změna větší než 1000%, ořízneme na -100%
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
              console.log(`    ✅ Updated trade ${trade.txSignature.substring(0, 16)}...: ${trade.side} → ${newType}, position: ${positionChangePercent?.toFixed(2)}%`);
            } else {
              totalSkipped++;
            }

            // Update balance for next iteration
            balanceBefore = balanceAfter;
          }
        }

        console.log(`    ✅ Wallet processed: ${allTrades.length} trades\n`);
      } catch (error: any) {
        console.error(`    ❌ Error processing wallet ${wallet.address}:`, error.message);
        totalErrors++;
      }
    }

    console.log(`\n✅ Recalculation completed!`);
    console.log(`   Updated: ${totalUpdated} trades`);
    console.log(`   Skipped: ${totalSkipped} trades (no changes needed)`);
    console.log(`   Errors: ${totalErrors} wallets`);
  } catch (error: any) {
    console.error('❌ Error during recalculation:', error);
    process.exit(1);
  }
}

recalculateTypesAndPositions();

