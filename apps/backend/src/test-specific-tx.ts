/**
 * Test konkrétní transakce z Helius API
 */

import dotenv from 'dotenv';
import { HeliusClient } from './services/helius-client.service.js';

dotenv.config();

async function main() {
  const txSignature = process.argv[2] || '5iMmcFZoYzCbSxnA5S3k8LjEjFauSbWV31fzBJ7apXW57jP75Lzy3qEqt6vmWCgTPVMFh1sCkTXxL4cVeMufqHgD';
  const walletAddress = process.argv[3] || 'HhYnLvkNqmv4t9yKJvFNrT4A4cEwDrPPMt3zdaZX1n76';
  
  console.log(`🧪 Testing specific transaction: ${txSignature}`);
  console.log(`   Wallet: ${walletAddress}`);
  console.log('');

  const heliusClient = new HeliusClient();
  
  if (!heliusClient.isAvailable()) {
    console.error('❌ Helius API key not configured');
    process.exit(1);
  }

  try {
    // Získej transakce pro walletku a najdi tu konkrétní
    console.log('📥 Fetching transactions from Helius API...');
    let transactions = await heliusClient.getTransactionsForAddress(walletAddress, {
      limit: 50,
      type: 'SWAP',
    });

    console.log(`✅ Found ${transactions.length} SWAP transactions\n`);

    // Najdi konkrétní transakci
    let tx = transactions.find((t: any) => t.signature === txSignature);
    
    if (!tx) {
      console.log(`⚠️  Transaction not found in first 50 swaps, checking more...`);
      
      // Zkus najít v širším rozsahu - fetch více
      let allTxs: any[] = [...transactions];
      let before = transactions.length > 0 ? transactions[transactions.length - 1].signature : undefined;
      
      for (let i = 0; i < 5; i++) {
        const moreTxs = await heliusClient.getTransactionsForAddress(walletAddress, {
          limit: 50,
          type: 'SWAP',
          before: before,
        });
        
        if (moreTxs.length === 0) break;
        
        allTxs = [...allTxs, ...moreTxs];
        before = moreTxs[moreTxs.length - 1].signature;
        
        tx = moreTxs.find((t: any) => t.signature === txSignature);
        if (tx) {
          console.log(`✅ Found transaction in extended search (total checked: ${allTxs.length})\n`);
          break;
        }
      }
      
      if (!tx) {
        console.log(`❌ Transaction ${txSignature} not found in ${allTxs.length} recent swaps.`);
        console.log(`   It might be too old or not detected as SWAP type by Helius.`);
        console.log(`\n   First few signatures:`);
        allTxs.slice(0, 5).forEach((t: any) => {
          console.log(`   - ${t.signature.substring(0, 16)}... (${new Date(t.timestamp * 1000).toISOString()})`);
        });
        return;
      }
    }
    
    await analyzeTransaction(tx, walletAddress, heliusClient);
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

async function analyzeTransaction(tx: any, walletAddress: string, heliusClient: HeliusClient) {
  console.log(`${'='.repeat(80)}`);
  console.log(`Transaction Analysis`);
  console.log(`${'='.repeat(80)}`);
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
        const userAcc = input.userAccount || input.fromUserAccount || 'N/A';
        const amount = input.rawTokenAmount ? Number(input.rawTokenAmount.tokenAmount) / (10 ** input.rawTokenAmount.decimals) : input.tokenAmount || 'N/A';
        console.log(`    [${idx}] mint: ${input.mint.substring(0, 8)}..., userAccount: ${userAcc.substring(0, 8)}..., amount: ${amount}`);
      });
    }
    
    if (swap.tokenOutputs && swap.tokenOutputs.length > 0) {
      console.log('\n  Token Outputs:');
      swap.tokenOutputs.forEach((output: any, idx: number) => {
        const userAcc = output.userAccount || output.toUserAccount || 'N/A';
        const amount = output.rawTokenAmount ? Number(output.rawTokenAmount.tokenAmount) / (10 ** output.rawTokenAmount.decimals) : output.tokenAmount || 'N/A';
        console.log(`    [${idx}] mint: ${output.mint.substring(0, 8)}..., userAccount: ${userAcc.substring(0, 8)}..., amount: ${amount}`);
      });
    }
    
    if (swap.innerSwaps && swap.innerSwaps.length > 0) {
      console.log('\n  Inner Swaps:');
      swap.innerSwaps.forEach((innerSwap: any, idx: number) => {
        console.log(`    [${idx}] tokenInputs: ${innerSwap.tokenInputs?.length || 0}, tokenOutputs: ${innerSwap.tokenOutputs?.length || 0}`);
        if (innerSwap.tokenInputs && innerSwap.tokenInputs.length > 0) {
          innerSwap.tokenInputs.forEach((input: any, iidx: number) => {
            const fromAcc = input.fromUserAccount || input.userAccount || 'N/A';
            const amount = input.rawTokenAmount ? Number(input.rawTokenAmount.tokenAmount) / (10 ** input.rawTokenAmount.decimals) : input.tokenAmount || 'N/A';
            console.log(`      Input[${iidx}]: mint: ${input.mint.substring(0, 8)}..., fromUserAccount: ${fromAcc.substring(0, 8)}..., amount: ${amount}`);
          });
        }
        if (innerSwap.tokenOutputs && innerSwap.tokenOutputs.length > 0) {
          innerSwap.tokenOutputs.forEach((output: any, oidx: number) => {
            const toAcc = output.toUserAccount || output.userAccount || 'N/A';
            const amount = output.rawTokenAmount ? Number(output.rawTokenAmount.tokenAmount) / (10 ** output.rawTokenAmount.decimals) : output.tokenAmount || 'N/A';
            console.log(`      Output[${oidx}]: mint: ${output.mint.substring(0, 8)}..., toUserAccount: ${toAcc.substring(0, 8)}..., amount: ${amount}`);
          });
        }
      });
    }
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

main();

