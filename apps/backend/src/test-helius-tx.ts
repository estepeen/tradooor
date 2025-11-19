/**
 * Testovací script pro Helius API
 * 
 * Použití:
 *   pnpm test:helius-tx <transaction_signature>
 * 
 * Nebo:
 *   tsx src/test-helius-tx.ts <transaction_signature>
 * 
 * Vytiskne všechny dostupné informace z Helius Enhanced Transactions API
 * pro danou transakci, včetně source, type, events.swap, atd.
 */

import dotenv from 'dotenv';
import { HeliusClient } from './services/helius-client.service.js';

dotenv.config();

async function main() {
  const txSignature = process.argv[2];

  if (!txSignature) {
    console.error('❌ Chybí transaction signature!');
    console.log('\nPoužití:');
    console.log('  pnpm test:helius-tx <transaction_signature>');
    console.log('  tsx src/test-helius-tx.ts <transaction_signature>');
    console.log('\nPříklad:');
    console.log('  pnpm test:helius-tx 5nsH6KvT3azXUyXe5QLH7ap1MPcv5MJ6RjTjmnkWXBYe2twy8YhiFC3fzVwDNCJA2YGQmzmUffiZMUDWtFJbgCfA');
    process.exit(1);
  }

  const heliusClient = new HeliusClient();

  if (!heliusClient.isAvailable()) {
    console.error('❌ Helius API key není nastavená!');
    console.log('Nastav HELIUS_API_KEY v .env souboru.');
    process.exit(1);
  }

  console.log(`\n🔍 Fetching transaction data from Helius API...`);
  console.log(`📋 Transaction signature: ${txSignature}\n`);

  try {
    // Zkusíme získat transakci přes Enhanced Transactions API
    // Helius Enhanced API má endpoint pro jednotlivé transakce
    const apiKey = process.env.HELIUS_API_KEY || process.env.HELIUS_API || '';
    const baseUrl = 'https://api.helius.xyz/v0';
    
    // Zkusíme získat transakci přes parse-transactions endpoint
    const parseUrl = `${baseUrl}/transactions/?api-key=${apiKey}`;
    
    const response = await fetch(parseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        transactions: [txSignature],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Helius API error: ${response.status} ${response.statusText}`);
      console.error(`Response: ${errorText}`);
      
      // Fallback: zkusíme získat transakci přes get-transaction endpoint
      console.log('\n🔄 Trying alternative endpoint...');
      const getTxUrl = `${baseUrl}/transactions/${txSignature}?api-key=${apiKey}`;
      const getResponse = await fetch(getTxUrl);
      
      if (!getResponse.ok) {
        const getErrorText = await getResponse.text();
        console.error(`❌ Alternative endpoint also failed: ${getResponse.status}`);
        console.error(`Response: ${getErrorText}`);
        process.exit(1);
      }
      
      const txData = await getResponse.json();
      printTransactionInfo(txData);
      return;
    }

    const data = await response.json() as any[];
    
    if (!data || !Array.isArray(data) || data.length === 0) {
      console.error('❌ Helius API vrátil prázdnou odpověď');
      process.exit(1);
    }

    const txData = data[0];
    printTransactionInfo(txData);

  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

function printTransactionInfo(tx: any) {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('📊 HELIUS TRANSACTION DATA');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Základní informace
  console.log('🔹 BASIC INFO:');
  console.log(`   Signature: ${tx.signature || 'N/A'}`);
  console.log(`   Type: ${tx.type || 'N/A'}`);
  console.log(`   Source: ${tx.source || 'N/A'}`);
  console.log(`   Timestamp: ${tx.timestamp ? new Date(tx.timestamp * 1000).toISOString() : 'N/A'}`);
  console.log(`   Fee: ${tx.fee ? `${tx.fee / 1e9} SOL` : 'N/A'}`);
  console.log(`   Fee Payer: ${tx.feePayer || 'N/A'}`);
  console.log(`   Slot: ${tx.slot || 'N/A'}`);
  console.log(`   Block Time: ${tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : 'N/A'}`);
  console.log();

  // Native transfers
  if (tx.nativeTransfers && tx.nativeTransfers.length > 0) {
    console.log('🔹 NATIVE TRANSFERS (SOL):');
    tx.nativeTransfers.forEach((transfer: any, idx: number) => {
      console.log(`   [${idx + 1}] ${transfer.fromUserAccount?.substring(0, 8)}... → ${transfer.toUserAccount?.substring(0, 8)}...`);
      console.log(`       Amount: ${transfer.amount ? `${transfer.amount / 1e9} SOL` : 'N/A'}`);
    });
    console.log();
  }

  // Token transfers
  if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
    console.log('🔹 TOKEN TRANSFERS:');
    tx.tokenTransfers.forEach((transfer: any, idx: number) => {
      console.log(`   [${idx + 1}] Mint: ${transfer.mint?.substring(0, 16)}...`);
      console.log(`       From: ${transfer.fromUserAccount?.substring(0, 8)}... → To: ${transfer.toUserAccount?.substring(0, 8)}...`);
      console.log(`       Amount: ${transfer.tokenAmount || transfer.rawTokenAmount?.tokenAmount || 'N/A'}`);
      console.log(`       Decimals: ${transfer.rawTokenAmount?.decimals || transfer.tokenAmount?.decimals || 'N/A'}`);
      if (transfer.tokenMetadata) {
        console.log(`       Token Metadata:`, JSON.stringify(transfer.tokenMetadata, null, 2));
      }
    });
    console.log();
  }

  // Account data
  if (tx.accountData && tx.accountData.length > 0) {
    console.log('🔹 ACCOUNT DATA:');
    tx.accountData.forEach((acc: any, idx: number) => {
      console.log(`   [${idx + 1}] Account: ${acc.account?.substring(0, 8)}...`);
      console.log(`       Native Balance Change: ${acc.nativeBalanceChange ? `${acc.nativeBalanceChange / 1e9} SOL` : 'N/A'}`);
      if (acc.tokenBalanceChanges && acc.tokenBalanceChanges.length > 0) {
        console.log(`       Token Balance Changes: ${acc.tokenBalanceChanges.length}`);
        acc.tokenBalanceChanges.forEach((change: any, cIdx: number) => {
          console.log(`         [${cIdx + 1}] Mint: ${change.mint?.substring(0, 16)}...`);
          console.log(`             Amount: ${change.rawTokenAmount?.tokenAmount || change.tokenAmount || 'N/A'}`);
        });
      }
    });
    console.log();
  }

  // Events (nejdůležitější pro swapy!)
  if (tx.events) {
    console.log('🔹 EVENTS:');
    console.log(JSON.stringify(tx.events, null, 2));
    console.log();

    if (tx.events.swap) {
      console.log('🔹 SWAP EVENT (detailed):');
      const swap = tx.events.swap;
      console.log(`   Native Input: ${swap.nativeInput ? `${swap.nativeInput.account?.substring(0, 8)}... ${Number(swap.nativeInput.amount) / 1e9} SOL` : 'none'}`);
      console.log(`   Native Output: ${swap.nativeOutput ? `${swap.nativeOutput.account?.substring(0, 8)}... ${Number(swap.nativeOutput.amount) / 1e9} SOL` : 'none'}`);
      console.log(`   Token Inputs: ${swap.tokenInputs?.length || 0}`);
      if (swap.tokenInputs && swap.tokenInputs.length > 0) {
        swap.tokenInputs.forEach((input: any, idx: number) => {
          console.log(`     [${idx + 1}] Mint: ${input.mint?.substring(0, 16)}...`);
          console.log(`         Amount: ${input.rawTokenAmount?.tokenAmount || input.tokenAmount || 'N/A'}`);
        });
      }
      console.log(`   Token Outputs: ${swap.tokenOutputs?.length || 0}`);
      if (swap.tokenOutputs && swap.tokenOutputs.length > 0) {
        swap.tokenOutputs.forEach((output: any, idx: number) => {
          console.log(`     [${idx + 1}] Mint: ${output.mint?.substring(0, 16)}...`);
          console.log(`         Amount: ${output.rawTokenAmount?.tokenAmount || output.tokenAmount || 'N/A'}`);
        });
      }
      if (swap.programInfo) {
        console.log(`   Program Info:`, JSON.stringify(swap.programInfo, null, 2));
      }
      if (swap.innerSwaps && swap.innerSwaps.length > 0) {
        console.log(`   Inner Swaps: ${swap.innerSwaps.length}`);
        swap.innerSwaps.forEach((inner: any, idx: number) => {
          console.log(`     [${idx + 1}]`, JSON.stringify(inner, null, 2));
        });
      }
      console.log();
    }
  }

  // Instructions
  if (tx.instructions && tx.instructions.length > 0) {
    console.log('🔹 INSTRUCTIONS:');
    tx.instructions.forEach((ix: any, idx: number) => {
      console.log(`   [${idx + 1}] Program: ${ix.programId?.substring(0, 16)}...`);
      console.log(`       Type: ${ix.type || 'N/A'}`);
      if (ix.data) {
        console.log(`       Data: ${JSON.stringify(ix.data).substring(0, 100)}...`);
      }
    });
    console.log();
  }

  // Programs
  if (tx.programs && tx.programs.length > 0) {
    console.log('🔹 PROGRAMS:');
    tx.programs.forEach((program: any, idx: number) => {
      console.log(`   [${idx + 1}] ${program || 'N/A'}`);
    });
    console.log();
  }

  // Raw JSON (pro úplnost)
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('📄 RAW JSON (full):');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(JSON.stringify(tx, null, 2));
  console.log();

  // Shrnutí pro DEX source
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('📋 DEX SOURCE SUMMARY:');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`   Type: ${tx.type || 'N/A'}`);
  console.log(`   Source: ${tx.source || 'N/A'}`);
  if (tx.events?.swap?.programInfo) {
    console.log(`   Swap Program Source: ${tx.events.swap.programInfo.source || 'N/A'}`);
    console.log(`   Swap Program Protocol: ${tx.events.swap.programInfo.protocol || 'N/A'}`);
    console.log(`   Swap Program: ${tx.events.swap.programInfo.program || 'N/A'}`);
  }
  console.log();
}

main().catch(console.error);

