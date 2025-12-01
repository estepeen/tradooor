import 'dotenv/config';

import { TradeRepository } from '../repositories/trade.repository.js';

/**
 * Jednoduchý sanity-check worker pro trady.
 *
 * Cíl:
 * - Najít případy, kdy je amountBase (v SOL) podezřele malý (typicky jen fee),
 *   ale v meta.heliusDebug.walletAccountData.nativeBalanceChange je výrazně větší změna.
 * - V takovém případě amountBase automaticky opravíme na větší hodnotu
 *   a přepočítáme priceBasePerToken.
 *
 * Používá pouze data z databáze (Trade.meta.heliusDebug), nevolá Helius API.
 */
async function main() {
  const tradeRepo = new TradeRepository();
  const pageSize = 500;
  let offset = 0;
  let fixed = 0;

  console.log('🔍 Running trades sanity check (fee-only amountBase detector)...');

  while (true) {
    const { trades, total } = await tradeRepo.findAll(pageSize, offset);
    if (!trades || trades.length === 0) {
      break;
    }

    for (const trade of trades as any[]) {
      try {
        const baseToken = trade.meta?.baseToken || 'SOL';
        if (baseToken !== 'SOL') {
          continue; // Zaměřujeme se na SOL trady, kde nás nejvíc trápily fee-only případy
        }

        const heliusDebug = trade.meta?.heliusDebug || {};
        const nativeChangeRaw = heliusDebug.walletAccountData?.nativeBalanceChange;

        // V Helius payloadu je nativeBalanceChange v lamports.
        // Přepočítáme ho na SOL, aby se dal přímo porovnávat s amountBase (které je v SOL).
        const accountDataNativeChangeLamports =
          nativeChangeRaw !== undefined && nativeChangeRaw !== null
            ? BigInt(String(nativeChangeRaw))
            : 0n;
        const accountDataNativeChange =
          Number(accountDataNativeChangeLamports) / 1e9; // SOL

        const amountBase = Number(trade.amountBase);
        const amountToken = Number(trade.amountToken);

        if (!amountBase || !amountToken || !accountDataNativeChange) {
          continue;
        }

        const absAccountData = Math.abs(accountDataNativeChange);

        // Heuristika:
        // - accountData musí být aspoň 0.1 SOL (ignorujeme čisté fee)
        // - accountData musí být > 10x větší než current amountBase
        if (absAccountData >= 0.1 && absAccountData > amountBase * 10) {
          const newAmountBase = absAccountData;
          const newPriceBasePerToken = newAmountBase / amountToken;

          console.log(
            `   ✅ Fixing trade ${trade.id} (tx=${String(trade.txSignature).substring(0, 12)}...) ` +
              `amountBase: ${amountBase.toFixed(9)} -> ${newAmountBase.toFixed(9)} SOL`
          );

          await tradeRepo.update(trade.id, {
            amountBase: newAmountBase,
            priceBasePerToken: newPriceBasePerToken,
          });

          fixed++;
        }
      } catch (error: any) {
        console.warn(
          `⚠️  Failed to process trade ${trade?.id || 'unknown'} in sanity-check worker:`,
          error?.message || error
        );
      }
    }

    offset += trades.length;
    console.log(`   Progress: ${Math.min(offset, total)} / ${total} trades processed...`);
    if (offset >= total) {
      break;
    }
  }

  console.log(`✅ Sanity check completed. Fixed trades: ${fixed}`);
}

main().catch((error) => {
  console.error('❌ Fatal error in trades sanity-check worker:', error);
  process.exit(1);
});


