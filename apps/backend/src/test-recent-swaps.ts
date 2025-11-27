/**
 * Test všech nedávných swapů
 */

import dotenv from 'dotenv';
import { HeliusClient } from './services/helius-client.service.js';

dotenv.config();

async function main() {
  const walletAddress = process.argv[2] || 'HhYnLvkNqmv4t9yKJvFNrT4A4cEwDrPPMt3zdaZX1n76';
  const hoursAgo = parseInt(process.argv[3] || '1');
  
  console.log(`🧪 Testing recent swaps for wallet: ${walletAddress}`);
  console.log(`   Looking for swaps from last ${hoursAgo} hour(s)`);
  console.log('');

  const heliusClient = new HeliusClient();
  
  if (!heliusClient.isAvailable()) {
    console.error('❌ Helius API key not configured');
    process.exit(1);
  }

  try {
    const now = Date.now();
    const cutoffTime = now - (hoursAgo * 60 * 60 * 1000);
    
    console.log('📥 Fetching transactions from Helius API...');
    let allTransactions: any[] = [];
    let before: string | undefined = undefined;
    
    // Fetch více transakcí - zkus bez filtru typu, pak filtruj
    for (let i = 0; i < 10; i++) {
      const transactions = await heliusClient.getTransactionsForAddress(walletAddress, {
        limit: 50,
        type: 'SWAP', // Zkus SWAP
        before: before,
      });
      
      if (transactions.length === 0) break;
      
      allTransactions = [...allTransactions, ...transactions];
      before = transactions[transactions.length - 1].signature;
      
      // Pokud jsou všechny transakce starší než cutoff, můžeme přestat
      const oldestTx = transactions[transactions.length - 1];
      if (oldestTx.timestamp * 1000 < cutoffTime) {
        break;
      }
    }
    
    // Pokud nenašli žádné nové, zkus bez typu
    if (allTransactions.length === 0 || (allTransactions[0] && allTransactions[0].timestamp * 1000 < cutoffTime)) {
      console.log('⚠️  No recent SWAP transactions, trying without type filter...');
      allTransactions = [];
      before = undefined;
      
      for (let i = 0; i < 5; i++) {
        try {
          // Zkus bez type filtru - možná Helius API podporuje prázdný type
          const transactions = await heliusClient.getTransactionsForAddress(walletAddress, {
            limit: 50,
            before: before,
          } as any);
          
          if (transactions.length === 0) break;
          
          // Filtruj jen SWAP typy
          const swapTxs = transactions.filter((tx: any) => tx.type === 'SWAP');
          allTransactions = [...allTransactions, ...swapTxs];
          before = transactions[transactions.length - 1].signature;
          
          const oldestTx = transactions[transactions.length - 1];
          if (oldestTx.timestamp * 1000 < cutoffTime) {
            break;
          }
        } catch (e) {
          break;
        }
      }
    }

    console.log(`✅ Found ${allTransactions.length} total SWAP transactions\n`);

    // Filtruj podle času
    const recentTxs = allTransactions.filter((tx: any) => {
      const txTime = tx.timestamp * 1000;
      return txTime >= cutoffTime;
    });

    console.log(`📊 Transactions from last ${hoursAgo} hour(s): ${recentTxs.length}\n`);

    if (recentTxs.length === 0) {
      console.log('⚠️  No recent transactions found');
      if (allTransactions.length > 0) {
        const newest = allTransactions[0];
        const oldest = allTransactions[allTransactions.length - 1];
        console.log(`   Newest: ${new Date(newest.timestamp * 1000).toISOString()}`);
        console.log(`   Oldest: ${new Date(oldest.timestamp * 1000).toISOString()}`);
      }
      return;
    }

    // Testuj každou transakci
    let successCount = 0;
    let failCount = 0;

    for (const tx of recentTxs) {
      console.log(`${'='.repeat(80)}`);
      console.log(`Transaction: ${tx.signature.substring(0, 16)}...`);
      console.log(`Time: ${new Date(tx.timestamp * 1000).toISOString()}`);
      console.log(`Source: ${tx.source}`);
      console.log('');

      const normalized = await heliusClient.normalizeSwap(tx, walletAddress);
      
      if (normalized) {
        successCount++;
        console.log(`✅ SUCCESS: ${normalized.side.toUpperCase()} ${normalized.amountToken.toFixed(4)} ${normalized.tokenMint.substring(0, 8)}... for ${normalized.amountBase} SOL`);
        console.log(`   Price: ${normalized.priceBasePerToken} SOL per token`);
        console.log(`   DEX: ${normalized.dex}`);
      } else {
        failCount++;
        console.log(`❌ FAILED to normalize`);
        
        // Zobraz strukturu
        if (tx.events?.swap) {
          const swap = tx.events.swap;
          console.log(`   Structure:`);
          console.log(`   - tokenInputs: ${swap.tokenInputs?.length || 0}`);
          console.log(`   - tokenOutputs: ${swap.tokenOutputs?.length || 0}`);
          console.log(`   - innerSwaps: ${swap.innerSwaps?.length || 0}`);
          console.log(`   - nativeInput: ${swap.nativeInput ? `${Number(swap.nativeInput.amount) / 1e9} SOL` : 'none'}`);
          console.log(`   - nativeOutput: ${swap.nativeOutput ? `${Number(swap.nativeOutput.amount) / 1e9} SOL` : 'none'}`);
        }
      }
      console.log('');
    }

    console.log(`${'='.repeat(80)}`);
    console.log(`Summary:`);
    console.log(`  Total recent swaps: ${recentTxs.length}`);
    console.log(`  ✅ Successfully normalized: ${successCount}`);
    console.log(`  ❌ Failed to normalize: ${failCount}`);
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();

