/**
 * Worker to recalculate trade prices using accountData.nativeBalanceChange
 * This fixes trades where amountBase was incorrectly calculated from events.swap
 * 
 * DISABLED: This worker was disabled because it uses Helius API directly,
 * which consumes API credits. We now use webhook-only approach.
 * 
 * Usage: pnpm fix:trade-prices (DISABLED)
 */

import 'dotenv/config';

async function recalculateTradePrices() {
  console.log('❌ This worker has been disabled.');
  console.log('   Reason: It uses Helius API directly, which consumes API credits.');
  console.log('   We now use webhook-only approach for all data collection.');
  console.log('   Historical recalculation is no longer supported.');
  process.exit(1);

  /* DISABLED CODE - kept for reference
  if (!heliusClient.isAvailable()) {
    console.error('❌ Helius API key not configured');
    process.exit(1);
  }

  try {
    // Get all trades
    console.log('📊 Fetching all trades from database...');
    const { data: trades, error } = await supabase
      .from(TABLES.TRADE)
      .select('*')
      .order('timestamp', { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch trades: ${error.message}`);
    }

    if (!trades || trades.length === 0) {
      console.log('✅ No trades found');
      return;
    }

    console.log(`✅ Found ${trades.length} trades\n`);

    let updated = 0;
    let skipped = 0;
    let errors = 0;

    // Process trades in batches to avoid overwhelming the API
    const BATCH_SIZE = 10;
    for (let i = 0; i < trades.length; i += BATCH_SIZE) {
      const batch = trades.slice(i, i + BATCH_SIZE);
      
      console.log(`\n📦 Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(trades.length / BATCH_SIZE)} (trades ${i + 1}-${Math.min(i + BATCH_SIZE, trades.length)})...`);

      for (const trade of batch) {
        try {
          const txSignature = trade.txSignature;
          
          // Fetch transaction from Helius with retry logic
          let tx = null;
          let retries = 3;
          let retryDelay = 1000; // Start with 1 second
          
          while (retries > 0 && !tx) {
            try {
              const url = `https://api.helius.xyz/v0/transactions/?api-key=${process.env.HELIUS_API_KEY}`;
              const response = await fetch(url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  transactions: [txSignature],
                }),
              });

              if (response.status === 429) {
                // Rate limited - wait and retry
                const retryAfter = parseInt(response.headers.get('retry-after') || '', 10) * 1000 || retryDelay * 2;
                console.warn(`   ⚠️  Rate limited for ${txSignature.substring(0, 8)}..., waiting ${retryAfter}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, retryAfter));
                retries--;
                retryDelay *= 2; // Exponential backoff
                continue;
              }

              if (!response.ok) {
                console.warn(`   ⚠️  Failed to fetch transaction ${txSignature.substring(0, 8)}...: ${response.status}`);
                skipped++;
                break;
              }

              const data = await response.json();
              if (!Array.isArray(data) || data.length === 0) {
                console.warn(`   ⚠️  No transaction data for ${txSignature.substring(0, 8)}...`);
                skipped++;
                break;
              }

              tx = data[0];
              break; // Success
            } catch (error: any) {
              retries--;
              if (retries > 0) {
                console.warn(`   ⚠️  Error fetching ${txSignature.substring(0, 8)}..., retrying... (${retries} retries left)`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                retryDelay *= 2;
              } else {
                console.error(`   ❌ Failed to fetch ${txSignature.substring(0, 8)}... after retries: ${error.message}`);
                skipped++;
              }
            }
          }

          if (!tx) {
            continue; // Skip this trade
          }

          // Get wallet address from trade
          const { data: walletData } = await supabase
            .from(TABLES.SMART_WALLET)
            .select('address')
            .eq('id', trade.walletId)
            .single();

          if (!walletData) {
            console.warn(`   ⚠️  Wallet not found for trade ${txSignature.substring(0, 8)}...`);
            skipped++;
            continue;
          }

          const walletAddress = walletData.address;

          // Get accountData.nativeBalanceChange
          let accountDataNativeChange = 0;
          if (tx.accountData) {
            const walletAccountData = tx.accountData.find((acc: any) => acc.account === walletAddress);
            if (walletAccountData && walletAccountData.nativeBalanceChange) {
              accountDataNativeChange = Math.abs(walletAccountData.nativeBalanceChange) / 1e9;
            }
          }

          // Get current amountBase from trade
          const currentAmountBase = Number(trade.amountBase || 0);

          // If accountData.nativeBalanceChange is significantly different (>10%), update the trade
          if (accountDataNativeChange > 0 && Math.abs(accountDataNativeChange - currentAmountBase) > currentAmountBase * 0.1) {
            // Recalculate price and USD value (použij historickou cenu SOL z doby transakce)
            const amountToken = Number(trade.amountToken || 0);
            const newPriceBasePerToken = amountToken > 0 ? accountDataNativeChange / amountToken : 0;
            const newValueUsd = await solPriceService.solToUsdAtDate(accountDataNativeChange, trade.timestamp);

            console.log(`   🔄 Updating trade ${txSignature.substring(0, 8)}...:`);
            console.log(`      Old amountBase: ${currentAmountBase} SOL`);
            console.log(`      New amountBase: ${accountDataNativeChange} SOL`);
            console.log(`      Old valueUsd: $${Number(trade.valueUsd || 0).toFixed(2)}`);
            console.log(`      New valueUsd: $${newValueUsd.toFixed(2)}`);

            // Update trade in database
            const { error: updateError } = await supabase
              .from(TABLES.TRADE)
              .update({
                amountBase: accountDataNativeChange,
                priceBasePerToken: newPriceBasePerToken,
                valueUsd: newValueUsd,
              })
              .eq('id', trade.id);

            if (updateError) {
              console.error(`   ❌ Failed to update trade: ${updateError.message}`);
              errors++;
            } else {
              updated++;
            }
          } else {
            skipped++;
          }

          // Small delay to avoid rate limiting (Helius Enhanced API allows ~5 requests/second)
          await new Promise(resolve => setTimeout(resolve, 250)); // 250ms = ~4 requests/second
        } catch (error: any) {
          console.error(`   ❌ Error processing trade ${trade.txSignature?.substring(0, 8)}...: ${error.message}`);
          errors++;
        }
      }
    }

    console.log(`\n✅ Recalculation complete!`);
    console.log(`   Updated: ${updated}`);
    console.log(`   Skipped: ${skipped}`);
    console.log(`   Errors: ${errors}`);
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
  */
}

recalculateTradePrices();

