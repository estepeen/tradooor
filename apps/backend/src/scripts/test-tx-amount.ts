/**
 * Test script to debug amountBase calculation for a specific transaction
 * Usage: tsx src/scripts/test-tx-amount.ts <TX_SIGNATURE>
 */

import { HeliusClient } from '../services/helius-client.service.js';

const TX_SIGNATURE = process.argv[2] || 'BBcSKw4utpWkLk5CQ7VrobgeUcEtYYFyWYykp9Z1FUSskF1Ln3RsMrfVhvCr2B2GuLFQM2HMeDMoDadpHg4umS1';
const WALLET_ADDRESS = process.argv[3] || ''; // Will be extracted from tx

async function main() {
  console.log(`🔍 Testing transaction: ${TX_SIGNATURE}`);
  
  const heliusClient = new HeliusClient();
  
  if (!heliusClient.isAvailable()) {
    console.error('❌ Helius API key not configured');
    process.exit(1);
  }

  try {
    // Fetch transaction
    console.log('\n📡 Fetching transaction from Helius...');
    const tx = await heliusClient.getTransaction(TX_SIGNATURE);
    
    if (!tx) {
      console.error('❌ Transaction not found');
      process.exit(1);
    }

    console.log(`✅ Transaction found`);
    console.log(`   Source: ${tx.source}`);
    console.log(`   Type: ${tx.type}`);
    console.log(`   Timestamp: ${new Date(tx.timestamp * 1000).toISOString()}`);
    console.log(`   Description: ${(tx as any).description || 'N/A'}`);

    // Extract wallet address from transaction
    // For SELL, we need to find the wallet that received SOL
    let walletAddress = WALLET_ADDRESS;
    
    const txWithEvents = tx as any;
    if (!walletAddress && txWithEvents.events?.swap) {
      // Try to find wallet from swap events
      const swap = txWithEvents.events.swap;
      if (swap.nativeOutput?.account) {
        walletAddress = swap.nativeOutput.account;
        console.log(`\n🔍 Detected wallet from nativeOutput: ${walletAddress}`);
      } else if (swap.tokenInputs && swap.tokenInputs.length > 0) {
        walletAddress = swap.tokenInputs[0].userAccount || swap.tokenInputs[0].fromUserAccount || '';
        if (walletAddress) {
          console.log(`\n🔍 Detected wallet from tokenInputs: ${walletAddress}`);
        }
      }
    }

    if (!walletAddress) {
      console.error('❌ Could not determine wallet address. Please provide it as second argument.');
      console.log('\n📊 Transaction structure:');
      console.log(JSON.stringify(tx, null, 2).substring(0, 2000));
      process.exit(1);
    }

    // Normalize swap
    console.log(`\n🔄 Normalizing swap for wallet: ${walletAddress}...`);
    const normalized = await heliusClient.normalizeSwap(tx as any, walletAddress);
    
    if (!normalized) {
      console.error('❌ Failed to normalize swap');
      console.log('\n📊 Transaction structure:');
      console.log(JSON.stringify(tx, null, 2).substring(0, 3000));
      process.exit(1);
    }

    console.log(`\n✅ Normalized swap:`);
    console.log(`   Side: ${normalized.side}`);
    console.log(`   Token Mint: ${normalized.tokenMint}`);
    console.log(`   Amount Token: ${normalized.amountToken.toLocaleString()}`);
    console.log(`   Amount Base: ${normalized.amountBase} ${normalized.baseToken}`);
    console.log(`   Price: ${normalized.priceBasePerToken.toFixed(8)} ${normalized.baseToken}/token`);
    console.log(`   Expected: 3.3088985 SOL`);
    console.log(`   Actual: ${normalized.amountBase} SOL`);
    console.log(`   Difference: ${Math.abs(normalized.amountBase - 3.3088985).toFixed(6)} SOL`);

    // Debug: Show swap structure
    if (txWithEvents.events?.swap) {
      console.log(`\n📊 Swap structure:`);
      const swap = txWithEvents.events.swap;
      console.log(`   nativeInput: ${swap.nativeInput ? `${swap.nativeInput.account.substring(0, 8)}... = ${Number(swap.nativeInput.amount) / 1e9} SOL` : 'none'}`);
      console.log(`   nativeOutput: ${swap.nativeOutput ? `${swap.nativeOutput.account.substring(0, 8)}... = ${Number(swap.nativeOutput.amount) / 1e9} SOL` : 'none'}`);
      console.log(`   tokenInputs: ${swap.tokenInputs?.length || 0}`);
      console.log(`   tokenOutputs: ${swap.tokenOutputs?.length || 0}`);
      console.log(`   innerSwaps: ${swap.innerSwaps?.length || 0}`);
      
      if (swap.tokenOutputs && swap.tokenOutputs.length > 0) {
        console.log(`\n   Token Outputs:`);
        swap.tokenOutputs.forEach((to: any, idx: number) => {
          const isWSOL = to.mint === 'So11111111111111111111111111111111111111112';
          const raw = to.rawTokenAmount?.tokenAmount;
          const tokenAmt = to.tokenAmount;
          console.log(`     [${idx}] mint: ${to.mint.substring(0, 16)}..., isWSOL: ${isWSOL}`);
          console.log(`         rawTokenAmount.tokenAmount: ${raw}`);
          console.log(`         tokenAmount: ${tokenAmt}`);
          console.log(`         toUserAccount: ${to.toUserAccount?.substring(0, 16)}...`);
          console.log(`         userAccount: ${to.userAccount?.substring(0, 16)}...`);
        });
      }
    }

    // Debug: Show native transfers
    if ((tx as any).nativeTransfers && (tx as any).nativeTransfers.length > 0) {
      console.log(`\n📊 Native Transfers:`);
      (tx as any).nativeTransfers.forEach((nt: any, idx: number) => {
        console.log(`   [${idx}] ${nt.fromUserAccount.substring(0, 8)}... -> ${nt.toUserAccount.substring(0, 8)}... = ${nt.amount / 1e9} SOL`);
      });
    }

    // Debug: Show accountData
    if ((tx as any).accountData && (tx as any).accountData.length > 0) {
      console.log(`\n📊 Account Data:`);
      (tx as any).accountData.forEach((acc: any) => {
        if (acc.account === walletAddress) {
          console.log(`   Wallet ${acc.account.substring(0, 8)}...:`);
          console.log(`     nativeBalanceChange: ${acc.nativeBalanceChange / 1e9} SOL`);
        }
      });
    }

  } catch (error: any) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();

