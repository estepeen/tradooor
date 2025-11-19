/**
 * Worker script pro přepočítání positionChangePercent pro všechny existující trendy
 * Spustí se jednou po přidání sloupce positionChangePercent do databáze
 * 
 * Použití:
 *   pnpm --filter backend position:recalculate
 */

import dotenv from 'dotenv';
import { supabase, TABLES } from '../lib/supabase.js';
import { TradeRepository } from '../repositories/trade.repository.js';

dotenv.config();

async function main() {
  console.log('🔄 Starting positionChangePercent recalculation...\n');

  const tradeRepo = new TradeRepository();

  // Načti všechny walletky
  const { data: wallets, error: walletsError } = await supabase
    .from(TABLES.SMART_WALLET)
    .select('id, address, label');

  if (walletsError) {
    console.error('❌ Error fetching wallets:', walletsError);
    process.exit(1);
  }

  if (!wallets || wallets.length === 0) {
    console.log('✅ No wallets found');
    process.exit(0);
  }

  console.log(`📊 Found ${wallets.length} wallets\n`);

  let totalUpdated = 0;
  let totalFailed = 0;

  for (const wallet of wallets) {
    console.log(`\n🔍 Processing wallet: ${wallet.label || wallet.address}...`);

    try {
      // Načti všechny trendy pro tuto walletku, seřazené chronologicky
      const allTrades = await tradeRepo.findAllForMetrics(wallet.id);

      if (allTrades.length === 0) {
        console.log(`   ⚠️  No trades found`);
        continue;
      }

      // Skupiny podle tokenu
      const tradesByToken = new Map<string, typeof allTrades>();
      for (const trade of allTrades) {
        const tokenId = trade.tokenId;
        if (!tradesByToken.has(tokenId)) {
          tradesByToken.set(tokenId, []);
        }
        tradesByToken.get(tokenId)!.push(trade);
      }

      let walletUpdated = 0;
      let walletFailed = 0;

      // Pro každý token vypočítej positionChangePercent pro každý trade
      for (const [tokenId, tokenTrades] of tradesByToken.entries()) {
        // Seřaď chronologicky
        tokenTrades.sort((a, b) => 
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );

        // Vypočítej aktuální pozici pro každý trade
        let currentPosition = 0;

        for (const trade of tokenTrades) {
          const positionChangePercent = calculatePositionChange(
            trade,
            currentPosition
          );

          // Aktualizuj positionChangePercent v databázi
          const { error: updateError } = await supabase
            .from(TABLES.TRADE)
            .update({
              positionChangePercent: positionChangePercent !== undefined
                ? positionChangePercent.toString()
                : null,
            })
            .eq('id', trade.id);

          if (updateError) {
            console.warn(`   ❌ Error updating trade ${trade.id.substring(0, 8)}...: ${updateError.message}`);
            walletFailed++;
          } else {
            walletUpdated++;
          }

          // Aktualizuj currentPosition pro další trade
          if (trade.side === 'buy') {
            currentPosition += trade.amountToken;
          } else if (trade.side === 'sell') {
            currentPosition -= trade.amountToken;
            currentPosition = Math.max(0, currentPosition); // Pozice nemůže být negativní
          }
        }
      }

      console.log(`   ✅ Updated: ${walletUpdated}, Failed: ${walletFailed}`);
      totalUpdated += walletUpdated;
      totalFailed += walletFailed;

    } catch (error: any) {
      console.error(`   ❌ Error processing wallet ${wallet.address}: ${error.message}`);
      totalFailed++;
    }
  }

  console.log(`\n✅ Recalculation completed:`);
  console.log(`   - Updated: ${totalUpdated}`);
  console.log(`   - Failed: ${totalFailed}`);
  console.log(`   - Total: ${totalUpdated + totalFailed}`);
  process.exit(0);
}

/**
 * Vypočítej positionChangePercent pro trade
 */
function calculatePositionChange(
  trade: any,
  currentPosition: number
): number | undefined {
  const { side, amountToken } = trade;

  // Omezení: pokud je currentPosition velmi malé (méně než 1% z amountToken),
  // považujeme to za novou pozici (100%) nebo prodej celé pozice (-100%)
  const MIN_POSITION_THRESHOLD = amountToken * 0.01; // 1% z amountToken

  if (side === 'buy') {
    // Koupil tokeny - přidal k pozici
    if (currentPosition > MIN_POSITION_THRESHOLD) {
      // Normální výpočet
      let positionChangePercent = (amountToken / currentPosition) * 100;
      // Omez na maximálně 1000% (10x) - pokud je více, je to pravděpodobně chyba
      if (positionChangePercent > 1000) {
        positionChangePercent = 100; // Považuj za novou pozici
      }
      return positionChangePercent;
    } else {
      // První koupě nebo velmi malá pozice - 100% nová pozice
      return 100;
    }
  } else if (side === 'sell') {
    // Prodal tokeny - odebral z pozice
    if (currentPosition > MIN_POSITION_THRESHOLD) {
      // Normální výpočet
      let positionChangePercent = -(amountToken / currentPosition) * 100;
      // Omez na maximálně -100% (celý prodej pozice)
      if (positionChangePercent < -100) {
        positionChangePercent = -100; // Považuj za prodej celé pozice
      }
      // Pokud je abs(positionChangePercent) velmi velké (více než 1000%), je to pravděpodobně chyba
      if (Math.abs(positionChangePercent) > 1000) {
        positionChangePercent = -100; // Považuj za prodej celé pozice
      }
      return positionChangePercent;
    } else {
      // Prodal, ale neměl pozici nebo velmi malou pozici
      // Pokud prodává víc, než má, je to chyba - označíme jako -100%
      if (amountToken > currentPosition) {
        return -100; // Prodej celé (malé) pozice
      } else {
        return currentPosition > 0 
          ? -(amountToken / currentPosition) * 100 
          : 0;
      }
    }
  }

  return undefined;
}

main();

