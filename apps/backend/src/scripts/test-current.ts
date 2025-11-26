
import { HeliusClient } from '../services/helius-client.service.js';

const TX_SIGNATURE = process.argv[2];
const WALLET_ADDRESS = process.argv[3];

if (!TX_SIGNATURE || !WALLET_ADDRESS) {
  console.error('Usage: tsx apps/backend/src/scripts/test-current.ts <TX_SIGNATURE> <WALLET_ADDRESS>');
  process.exit(1);
}

async function main() {
  console.log(`🔍 TESTING CURRENT PRODUCTION LOGIC`);
  console.log(`   TX: ${TX_SIGNATURE}`);
  console.log(`   Wallet: ${WALLET_ADDRESS}`);
  
  const heliusClient = new HeliusClient();
  
  try {
    const tx = await heliusClient.getTransaction(TX_SIGNATURE);
    if (!tx) {
      console.error('❌ Transaction not found');
      process.exit(1);
    }

    console.log(`\n🔄 Normalizing swap...`);
    const normalized = heliusClient.normalizeSwap(tx as any, WALLET_ADDRESS);
    
    if (!normalized) {
      console.log('❌ Failed to normalize swap (returned null)');
    } else {
      console.log(`✅ RESULT:`);
      console.log(`   Side: ${normalized.side}`);
      console.log(`   Token Mint: ${normalized.tokenMint}`);
      console.log(`   Amount Token: ${normalized.amountToken}`);
      console.log(`   Amount Base (SOL): ${normalized.amountBase} ${normalized.baseToken}`);
    }

  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }
}

main();

