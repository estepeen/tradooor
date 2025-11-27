/**
 * Test script pro debugování Helius swap normalizace
 * 
 * Použití:
 *   pnpm --filter backend tsx src/test-helius-swap.ts WALLET_ADDRESS
 */

import dotenv from 'dotenv';
import { HeliusClient } from './services/helius-client.service.js';

dotenv.config();

async function main() {
  const walletAddress = process.argv[2] || 'HhYnLvkNqmv4t9yKJvFNrT4A4cEwDrPPMt3zdaZX1n76';
  
  console.log(`🧪 Testing Helius swap normalization for wallet: ${walletAddress}`);
  console.log('');

  const heliusClient = new HeliusClient();
  
  if (!heliusClient.isAvailable()) {
    console.error('❌ Helius API key not configured');
    process.exit(1);
  }

  try {
    // Získej nejnovější swapy
    console.log('📥 Fetching transactions from Helius API...');
    const transactions = await heliusClient.getTransactionsForAddress(walletAddress, {
      limit: 10,
      type: 'SWAP',
    });

    console.log(`✅ Found ${transactions.length} SWAP transactions\n`);

    if (transactions.length === 0) {
      console.log('⚠️  No swap transactions found');
      return;
    }

    // Testuj každou transakci
    for (let i = 0; i < Math.min(transactions.length, 5); i++) {
      const tx = transactions[i] as any;
      console.log(`\n${'='.repeat(80)}`);
      console.log(`Transaction ${i + 1}/${Math.min(transactions.length, 5)}`);
      console.log(`Signature: ${tx.signature}`);
      console.log(`Source: ${tx.source}`);
      console.log(`Timestamp: ${new Date(tx.timestamp * 1000).toISOString()}`);
      console.log(`Type: ${tx.type}`);
      console.log('');

      // Zkontroluj strukturu
      console.log('📊 Transaction structure:');
      console.log(`  - has events: ${!!tx.events}`);
      console.log(`  - has events.swap: ${!!tx.events?.swap}`);
      
      if (tx.events?.swap) {
        const swap = tx.events.swap;
        console.log(`  - tokenInputs: ${swap.tokenInputs?.length || 0}`);
        console.log(`  - tokenOutputs: ${swap.tokenOutputs?.length || 0}`);
        console.log(`  - innerSwaps: ${swap.innerSwaps?.length || 0}`);
        console.log(`  - nativeInput: ${swap.nativeInput ? `${swap.nativeInput.account.substring(0, 8)}... ${Number(swap.nativeInput.amount) / 1e9} SOL` : 'none'}`);
        console.log(`  - nativeOutput: ${swap.nativeOutput ? `${swap.nativeOutput.account.substring(0, 8)}... ${Number(swap.nativeOutput.amount) / 1e9} SOL` : 'none'}`);
        
        if (swap.tokenInputs && swap.tokenInputs.length > 0) {
          console.log('\n  Token Inputs:');
          swap.tokenInputs.forEach((input: any, idx: number) => {
            console.log(`    [${idx}] mint: ${input.mint.substring(0, 8)}..., userAccount: ${(input.userAccount || input.fromUserAccount || 'N/A').substring(0, 8)}..., amount: ${input.rawTokenAmount ? Number(input.rawTokenAmount.tokenAmount) / (10 ** input.rawTokenAmount.decimals) : 'N/A'}`);
          });
        }
        
        if (swap.tokenOutputs && swap.tokenOutputs.length > 0) {
          console.log('\n  Token Outputs:');
          swap.tokenOutputs.forEach((output: any, idx: number) => {
            console.log(`    [${idx}] mint: ${output.mint.substring(0, 8)}..., userAccount: ${(output.userAccount || output.toUserAccount || 'N/A').substring(0, 8)}..., amount: ${output.rawTokenAmount ? Number(output.rawTokenAmount.tokenAmount) / (10 ** output.rawTokenAmount.decimals) : 'N/A'}`);
          });
        }
        
        if (swap.innerSwaps && swap.innerSwaps.length > 0) {
          console.log('\n  Inner Swaps:');
          swap.innerSwaps.forEach((innerSwap: any, idx: number) => {
            console.log(`    [${idx}] tokenInputs: ${innerSwap.tokenInputs?.length || 0}, tokenOutputs: ${innerSwap.tokenOutputs?.length || 0}`);
            if (innerSwap.tokenInputs && innerSwap.tokenInputs.length > 0) {
              innerSwap.tokenInputs.forEach((input: any, iidx: number) => {
                console.log(`      Input[${iidx}]: mint: ${input.mint.substring(0, 8)}..., fromUserAccount: ${(input.fromUserAccount || input.userAccount || 'N/A').substring(0, 8)}..., amount: ${input.rawTokenAmount ? Number(input.rawTokenAmount.tokenAmount) / (10 ** input.rawTokenAmount.decimals) : input.tokenAmount || 'N/A'}`);
              });
            }
            if (innerSwap.tokenOutputs && innerSwap.tokenOutputs.length > 0) {
              innerSwap.tokenOutputs.forEach((output: any, oidx: number) => {
                console.log(`      Output[${oidx}]: mint: ${output.mint.substring(0, 8)}..., toUserAccount: ${(output.toUserAccount || output.userAccount || 'N/A').substring(0, 8)}..., amount: ${output.rawTokenAmount ? Number(output.rawTokenAmount.tokenAmount) / (10 ** output.rawTokenAmount.decimals) : output.tokenAmount || 'N/A'}`);
              });
            }
          });
        }
      } else {
        console.log('  ⚠️  No events.swap found - showing tokenTransfers instead:');
        console.log(`  - tokenTransfers: ${tx.tokenTransfers?.length || 0}`);
        console.log(`  - nativeTransfers: ${tx.nativeTransfers?.length || 0}`);
      }

      // Zkus normalizovat
      console.log('\n🔄 Attempting normalization...');
      const normalized = await heliusClient.normalizeSwap(tx, walletAddress);
      
      if (normalized) {
        console.log('✅ Normalization SUCCESS:');
        console.log(`  - side: ${normalized.side}`);
        console.log(`  - tokenMint: ${normalized.tokenMint}`);
        console.log(`  - amountToken: ${normalized.amountToken}`);
        console.log(`  - amountBase: ${normalized.amountBase} SOL`);
        console.log(`  - priceBasePerToken: ${normalized.priceBasePerToken}`);
        console.log(`  - dex: ${normalized.dex}`);
      } else {
        console.log('❌ Normalization FAILED');
        console.log('\nFull swap event structure:');
        console.log(JSON.stringify(tx.events?.swap, null, 2));
      }
    }

    console.log(`\n${'='.repeat(80)}\n`);
    console.log('✅ Test completed');
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();

