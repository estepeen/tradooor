/**
 * Test script to debug price calculation for a specific transaction
 * Usage: pnpm test:specific-tx-price
 */

import 'dotenv/config';
import { HeliusClient } from './services/helius-client.service.js';
import { SolPriceService } from './services/sol-price.service.js';

const TX_SIGNATURE = '5nsH6KvT3azXUyXe5QLH7ap1MPcv5MJ6RjTjmnkWXBYe2twy8YhiFC3fzVwDNCJA2YGQmzmUffiZMUDWtFJbgCfA';
const WALLET_ADDRESS = 'HhYnLvkNqmv4t9yKJvFNrT4A4cEwDrPPMt3zdaZX1n76';

async function testTransaction() {
  console.log('🔍 Testing transaction price calculation...\n');
  console.log(`Transaction: ${TX_SIGNATURE}`);
  console.log(`Wallet: ${WALLET_ADDRESS}\n`);

  const heliusClient = new HeliusClient();
  const solPriceService = new SolPriceService();

  if (!heliusClient.isAvailable()) {
    console.error('❌ Helius API key not configured');
    process.exit(1);
  }

  try {
    // Fetch transaction from Helius
    console.log('📡 Fetching transaction from Helius...');
    const url = `https://api.helius.xyz/v0/transactions/?api-key=${process.env.HELIUS_API_KEY}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        transactions: [TX_SIGNATURE],
      }),
    });

    if (!response.ok) {
      console.error(`❌ Helius API error: ${response.status}`);
      const errorText = await response.text();
      console.error(`Response: ${errorText}`);
      process.exit(1);
    }

    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) {
      console.error('❌ No transaction data returned');
      process.exit(1);
    }

    const tx = data[0];
    console.log('✅ Transaction fetched\n');

    // Log full transaction structure
    console.log('📋 Transaction structure:');
    console.log(`   Type: ${tx.type}`);
    console.log(`   Source: ${tx.source}`);
    console.log(`   Timestamp: ${new Date(tx.timestamp * 1000).toISOString()}`);
    console.log(`   Has events.swap: ${!!tx.events?.swap}`);
    console.log(`   Native transfers: ${tx.nativeTransfers?.length || 0}`);
    console.log(`   Token transfers: ${tx.tokenTransfers?.length || 0}\n`);

    // Log native transfers
    if (tx.nativeTransfers && tx.nativeTransfers.length > 0) {
      console.log('💰 Native transfers:');
      tx.nativeTransfers.forEach((transfer: any, idx: number) => {
        const amount = transfer.amount / 1e9;
        console.log(`   [${idx + 1}] ${transfer.fromUserAccount.substring(0, 8)}... → ${transfer.toUserAccount.substring(0, 8)}...: ${amount} SOL`);
        if (transfer.fromUserAccount === WALLET_ADDRESS || transfer.toUserAccount === WALLET_ADDRESS) {
          console.log(`       ⭐ This transfer involves our wallet!`);
        }
      });
      console.log();
    }

    // Log token transfers
    if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
      console.log('🪙 Token transfers:');
      tx.tokenTransfers.forEach((transfer: any, idx: number) => {
        console.log(`   [${idx + 1}] ${transfer.mint.substring(0, 8)}...`);
        console.log(`       From: ${transfer.fromUserAccount.substring(0, 8)}...`);
        console.log(`       To: ${transfer.toUserAccount.substring(0, 8)}...`);
        console.log(`       Amount: ${transfer.tokenAmount}`);
        if (transfer.fromUserAccount === WALLET_ADDRESS || transfer.toUserAccount === WALLET_ADDRESS) {
          console.log(`       ⭐ This transfer involves our wallet!`);
        }
      });
      console.log();
    }

    // Log events.swap if available
    if (tx.events?.swap) {
      const swap = tx.events.swap;
      console.log('🔄 Swap event structure:');
      console.log(`   Token inputs: ${swap.tokenInputs?.length || 0}`);
      console.log(`   Token outputs: ${swap.tokenOutputs?.length || 0}`);
      console.log(`   Native input: ${swap.nativeInput ? `${swap.nativeInput.account.substring(0, 8)}... - ${Number(swap.nativeInput.amount) / 1e9} SOL` : 'none'}`);
      console.log(`   Native output: ${swap.nativeOutput ? `${swap.nativeOutput.account.substring(0, 8)}... - ${Number(swap.nativeOutput.amount) / 1e9} SOL` : 'none'}`);
      console.log(`   Inner swaps: ${swap.innerSwaps?.length || 0}\n`);

      if (swap.tokenInputs && swap.tokenInputs.length > 0) {
        console.log('   Token inputs:');
        swap.tokenInputs.forEach((input: any, idx: number) => {
          const amount = input.rawTokenAmount 
            ? Number(input.rawTokenAmount.tokenAmount) / (10 ** input.rawTokenAmount.decimals)
            : input.tokenAmount || 0;
          const account = input.userAccount || input.fromUserAccount || 'unknown';
          console.log(`     [${idx + 1}] ${input.mint.substring(0, 8)}... - ${amount} (account: ${account.substring(0, 8)}...)`);
          if (account === WALLET_ADDRESS) {
            console.log(`         ⭐ This input is from our wallet!`);
          }
        });
        console.log();
      }

      if (swap.tokenOutputs && swap.tokenOutputs.length > 0) {
        console.log('   Token outputs:');
        swap.tokenOutputs.forEach((output: any, idx: number) => {
          const amount = output.rawTokenAmount 
            ? Number(output.rawTokenAmount.tokenAmount) / (10 ** output.rawTokenAmount.decimals)
            : output.tokenAmount || 0;
          const account = output.userAccount || output.toUserAccount || 'unknown';
          console.log(`     [${idx + 1}] ${output.mint.substring(0, 8)}... - ${amount} (account: ${account.substring(0, 8)}...)`);
          if (account === WALLET_ADDRESS) {
            console.log(`         ⭐ This output is to our wallet!`);
          }
        });
        console.log();
      }

      if (swap.innerSwaps && swap.innerSwaps.length > 0) {
        console.log('   Inner swaps:');
        swap.innerSwaps.forEach((innerSwap: any, idx: number) => {
          console.log(`     [${idx + 1}] Inner swap ${idx + 1}:`);
          console.log(`         Token inputs: ${innerSwap.tokenInputs?.length || 0}`);
          console.log(`         Token outputs: ${innerSwap.tokenOutputs?.length || 0}`);
          if (innerSwap.nativeInput) {
            console.log(`         Native input: ${innerSwap.nativeInput.account.substring(0, 8)}... - ${Number(innerSwap.nativeInput.amount) / 1e9} SOL`);
          }
          if (innerSwap.nativeOutput) {
            console.log(`         Native output: ${innerSwap.nativeOutput.account.substring(0, 8)}... - ${Number(innerSwap.nativeOutput.amount) / 1e9} SOL`);
          }
        });
        console.log();
      }
    }

    // Normalize swap
    console.log('🔄 Normalizing swap...');
    const normalized = await heliusClient.normalizeSwap(tx, WALLET_ADDRESS);
    
    if (!normalized) {
      console.error('❌ Failed to normalize swap');
      process.exit(1);
    }

    console.log('✅ Swap normalized:\n');
    console.log(`   Side: ${normalized.side}`);
    console.log(`   Token: ${normalized.tokenMint.substring(0, 16)}...`);
    console.log(`   Amount token: ${normalized.amountToken}`);
    console.log(`   Amount base (SOL): ${normalized.amountBase}`);
    console.log(`   Price (SOL per token): ${normalized.priceBasePerToken}`);
    console.log(`   DEX: ${normalized.dex}\n`);

    // Calculate USD value
    const solPrice = await solPriceService.getSolPriceUsd();
    const valueUsd = normalized.amountBase * solPrice;
    
    console.log('💵 Price calculation:');
    console.log(`   SOL price: $${solPrice}`);
    console.log(`   Amount base (SOL): ${normalized.amountBase}`);
    console.log(`   Value USD: $${valueUsd.toFixed(2)}\n`);

    // Expected value from Solscan: ~$393.99
    const expectedValue = 393.99;
    const difference = Math.abs(valueUsd - expectedValue);
    const percentDiff = (difference / expectedValue) * 100;

    console.log('📊 Comparison:');
    console.log(`   Expected (from Solscan): $${expectedValue}`);
    console.log(`   Calculated: $${valueUsd.toFixed(2)}`);
    console.log(`   Difference: $${difference.toFixed(2)} (${percentDiff.toFixed(2)}%)\n`);

    if (percentDiff > 5) {
      console.log('⚠️  WARNING: Significant difference detected!');
      console.log('   This indicates a problem with amountBase calculation.\n');
    } else {
      console.log('✅ Price calculation looks correct!\n');
    }

  } catch (error: any) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

testTransaction();

