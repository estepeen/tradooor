/**
 * Debug script: prints full Helius transaction details for a specific signature.
 *
 * Usage:
 *   pnpm --filter @solbot/backend debug:tx <TX_SIGNATURE> <WALLET_ADDRESS>
 *
 * Examples:
 *   pnpm --filter @solbot/backend debug:tx DJ3nPD57tyaeja1snbqHYhNe8Lb2RUJA3CQP6PM91GsYPuNFsAwAdbsJ1freJ3cK1EdkF4kGiyPq7xuwrBMWjuC HhYnLvkNqmv4t9yKJvFNrT4A4cEwDrPPMt3zdaZX1n76
 *
 * The script fetches the enhanced transaction from Helius, logs every relevant
 * section (native & token transfers, events.swap, accountData etc.) and then
 * runs our normalizeSwap logic to show how collector interprets the TX.
 */

import 'dotenv/config';
import { HeliusClient } from './services/helius-client.service.js';
import { SolPriceService } from './services/sol-price.service.js';

const DEFAULT_TX =
  '5nsH6KvT3azXUyXe5QLH7ap1MPcv5MJ6RjTjmnkWXBYe2twy8YhiFC3fzVwDNCJA2YGQmzmUffiZMUDWtFJbgCfA';
const DEFAULT_WALLET = 'HhYnLvkNqmv4t9yKJvFNrT4A4cEwDrPPMt3zdaZX1n76';

const TX_SIGNATURE = process.argv[2] || DEFAULT_TX;
const WALLET_ADDRESS = process.argv[3] || DEFAULT_WALLET;

async function fetchTransaction(signature: string) {
  if (!process.env.HELIUS_API_KEY) {
    throw new Error('HELIUS_API_KEY is not configured');
  }

  const url = `https://api.helius.xyz/v0/transactions/?api-key=${process.env.HELIUS_API_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactions: [signature] }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Helius API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('Helius API returned empty result');
  }

  return data[0];
}

function logTokenTransfer(transfer: any, idx: number) {
  const amount =
    transfer.rawTokenAmount && transfer.rawTokenAmount.tokenAmount
      ? Number(transfer.rawTokenAmount.tokenAmount) /
        Math.pow(10, transfer.rawTokenAmount.decimals || 0)
      : transfer.tokenAmount || 0;

  console.log(`   [${idx + 1}] ${transfer.mint?.substring(0, 8)}...`);
  console.log(
    `       from=${(transfer.fromUserAccount || transfer.userAccount || 'unknown').substring(0, 12)}...`
  );
  console.log(
    `       to=${(transfer.toUserAccount || transfer.userAccount || 'unknown').substring(0, 12)}...`
  );
  console.log(`       amount=${amount}`);
}

function logSwapEvent(tx: any) {
  const swap = tx.events?.swap;
  if (!swap) return;

  console.log('\n🔄 events.swap payload:');
  console.log(
    `   tokenInputs=${swap.tokenInputs?.length || 0}, tokenOutputs=${swap.tokenOutputs?.length || 0}, innerSwaps=${
      swap.innerSwaps?.length || 0
    }`
  );
  if (swap.nativeInput) {
    console.log(
      `   nativeInput=${swap.nativeInput.account?.substring(0, 12)}... amount=${
        Number(swap.nativeInput.amount) / 1e9
      } SOL`
    );
  }
  if (swap.nativeOutput) {
    console.log(
      `   nativeOutput=${swap.nativeOutput.account?.substring(0, 12)}... amount=${
        Number(swap.nativeOutput.amount) / 1e9
      } SOL`
    );
  }

  if (swap.tokenInputs?.length) {
    console.log('   tokenInputs:');
    swap.tokenInputs.forEach((input: any, idx: number) => {
      const amount =
        input.rawTokenAmount && input.rawTokenAmount.tokenAmount
          ? Number(input.rawTokenAmount.tokenAmount) / Math.pow(10, input.rawTokenAmount.decimals || 0)
          : input.tokenAmount || 0;
      const account = input.userAccount || input.fromUserAccount || 'unknown';
      console.log(
        `     [${idx + 1}] ${input.mint?.substring(0, 8)}... amount=${amount} account=${account.substring(0, 12)}...`
      );
    });
  }

  if (swap.tokenOutputs?.length) {
    console.log('   tokenOutputs:');
    swap.tokenOutputs.forEach((output: any, idx: number) => {
      const amount =
        output.rawTokenAmount && output.rawTokenAmount.tokenAmount
          ? Number(output.rawTokenAmount.tokenAmount) / Math.pow(10, output.rawTokenAmount.decimals || 0)
          : output.tokenAmount || 0;
      const account = output.userAccount || output.toUserAccount || 'unknown';
      console.log(
        `     [${idx + 1}] ${output.mint?.substring(0, 8)}... amount=${amount} account=${account.substring(0, 12)}...`
      );
    });
  }
}

async function main() {
  console.log('🔍 Debugging transaction');
  console.log(`   Signature: ${TX_SIGNATURE}`);
  console.log(`   Wallet:    ${WALLET_ADDRESS}\n`);

  const heliusClient = new HeliusClient();
  const solPriceService = new SolPriceService();

  if (!heliusClient.isAvailable()) {
    console.error('❌ Helius API key not configured');
    process.exit(1);
  }

  try {
    console.log('📡 Fetching transaction from Helius...');
    const tx = await fetchTransaction(TX_SIGNATURE);
    console.log('✅ Transaction fetched.\n');

    console.log('📋 General info:');
    console.log(`   type=${tx.type}`);
    console.log(`   source=${tx.source}`);
    console.log(`   timestamp=${new Date(tx.timestamp * 1000).toISOString()}`);
    console.log(`   fee=${tx.fee / 1e9} SOL`);
    if (typeof tx.priorityFee === 'number') {
      console.log(`   priorityFee=${tx.priorityFee / 1e9} SOL`);
    }
    if (typeof tx.computeUnitsConsumed === 'number') {
      console.log(`   computeUnitsConsumed=${tx.computeUnitsConsumed}`);
    }
    if (tx.feePayer) {
      console.log(`   feePayer=${tx.feePayer.substring(0, 12)}...`);
    }
    console.log(`   numInstructions=${tx.instructions?.length || 0}`);
    console.log(`   numTokenTransfers=${tx.tokenTransfers?.length || 0}`);
    console.log(`   numNativeTransfers=${tx.nativeTransfers?.length || 0}`);
    console.log(`   accountData entries=${tx.accountData?.length || 0}\n`);

    if (tx.accountData?.length) {
      console.log('📊 accountData (nativeBalanceChange):');
      tx.accountData.forEach((acc: any) => {
        if (!acc.nativeBalanceChange) return;
        console.log(
          `   ${acc.account.substring(0, 12)}... change=${acc.nativeBalanceChange / 1e9} SOL`
        );
      });
      console.log();
    }

    if (tx.nativeTransfers?.length) {
      console.log('💰 Native transfers:');
      tx.nativeTransfers.forEach((transfer: any, idx: number) => {
        const amount = transfer.amount / 1e9;
        console.log(
          `   [${idx + 1}] ${transfer.fromUserAccount?.substring(0, 12)}... → ${transfer.toUserAccount?.substring(
            0,
            12
          )}... : ${amount} SOL`
        );
      });
      console.log();
    }

    if (tx.tokenTransfers?.length) {
      console.log('🪙 Token transfers:');
      tx.tokenTransfers.forEach(logTokenTransfer);
      console.log();
    }

    logSwapEvent(tx);

    console.log('🧮 Running normalizeSwap...');
    const normalized = heliusClient.normalizeSwap(tx, WALLET_ADDRESS);
    if (!normalized) {
      console.log('❌ normalizeSwap returned null (collector would skip this transaction)');
    } else {
      console.log('✅ normalizeSwap result:');
      console.log(`   side=${normalized.side}`);
      console.log(`   tokenMint=${normalized.tokenMint}`);
      console.log(`   amountToken=${normalized.amountToken}`);
      console.log(`   amountBase=${normalized.amountBase} SOL`);
      console.log(`   priceBasePerToken=${normalized.priceBasePerToken}`);
      console.log(`   dex=${normalized.dex}`);

      const solPrice = await solPriceService.getSolPriceUsd();
      const valueUsd = normalized.amountBase * solPrice;
      console.log(`   ≈ valueUSD=${valueUsd.toFixed(2)} (SOL price: $${solPrice})`);
    }

    console.log('\n✅ Debug complete.');
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();


