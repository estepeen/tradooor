
import { HeliusClient } from '../services/helius-client.service.js';

// Simulate the OLD faulty logic directly in this script
// We override the normalizeSwapLegacy behavior to mimic the bug

const TX_SIGNATURE = process.argv[2];
const WALLET_ADDRESS = process.argv[3];

if (!TX_SIGNATURE || !WALLET_ADDRESS) {
  console.error('Usage: tsx apps/backend/src/scripts/test-legacy-faulty.ts <TX_SIGNATURE> <WALLET_ADDRESS>');
  process.exit(1);
}

async function main() {
  console.log(`🔍 TESTING OLD FAULTY LOGIC (Simulation)`);
  console.log(`   TX: ${TX_SIGNATURE}`);
  console.log(`   Wallet: ${WALLET_ADDRESS}`);
  
  const heliusClient = new HeliusClient();
  
  try {
    const tx = await heliusClient.getTransaction(TX_SIGNATURE);
    if (!tx) {
      console.error('❌ Transaction not found');
      process.exit(1);
    }

    // SIMULATION OF FAULTY LOGIC
    // This mimics how the code behaved before the fix:
    // It summed ALL native transfers without checking fromUserAccount === walletAddress
    
    const heliusTx = tx as any;
    
    // FAULTY PART: Taking all native transfers
    const nativeOutAmounts = (heliusTx.nativeTransfers || [])
      .map((transfer: any) => transfer.amount / 1e9);
      
    // FAULTY PART: Summing everything regardless of who sent it
    const nativeOutTotal = nativeOutAmounts.length > 0 ? nativeOutAmounts.reduce((sum: number, val: number) => sum + val, 0) : 0;
    
    console.log(`\n🚨 FAULTY LOGIC RESULT:`);
    console.log(`   Sum of ALL native transfers (Faulty amountBase): ${nativeOutTotal} SOL`);
    console.log(`   (This matches the error 0.0426 SOL you saw)`);

  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }
}

main();

