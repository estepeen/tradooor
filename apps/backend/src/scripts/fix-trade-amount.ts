import 'dotenv/config';
import { HeliusClient } from '../services/helius-client.service.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { supabase, TABLES } from '../lib/supabase.js';

const TX_SIGNATURE = 'vvu4TLTiSMh7SKgTDrHwcc5d1SyNMbg3eYCaNUH6nL4CaDZ9J6qkrRJevHdocgbmTDodmmW5uz8Yr5ZG7Zk8eY8';
const EXPECTED_AMOUNT_BASE = 10.115; // SOL

async function fixTradeAmount() {
  console.log(`🔍 Fetching transaction ${TX_SIGNATURE}...`);
  
  const heliusClient = new HeliusClient();
  const tradeRepo = new TradeRepository();
  
  // 1. Najdi trade v databázi
  const trade = await tradeRepo.findBySignature(TX_SIGNATURE);
  if (!trade) {
    console.error(`❌ Trade not found in database: ${TX_SIGNATURE}`);
    return;
  }
  
  console.log(`📊 Current trade data:`);
  console.log(`   amountBase: ${trade.amountBase}`);
  console.log(`   amountToken: ${trade.amountToken}`);
  console.log(`   priceBasePerToken: ${trade.priceBasePerToken}`);
  console.log(`   walletId: ${trade.walletId}`);
  console.log(`   side: ${trade.side}`);
  
  // 2. Fetch transaction z Helius API
  const heliusTx = await heliusClient.getTransaction(TX_SIGNATURE);
  if (!heliusTx) {
    console.error(`❌ Transaction not found in Helius: ${TX_SIGNATURE}`);
    return;
  }
  
  console.log(`\n📡 Helius transaction data:`);
  console.log(`   nativeTransfers:`, heliusTx.nativeTransfers?.length || 0);
  console.log(`   tokenTransfers:`, heliusTx.tokenTransfers?.length || 0);
  
  // 3. Analyzuj native transfers
  const walletAddress = (await supabase
    .from(TABLES.SMART_WALLET)
    .select('address')
    .eq('id', trade.walletId)
    .single()).data?.address;
  
  if (!walletAddress) {
    console.error(`❌ Wallet not found: ${trade.walletId}`);
    return;
  }
  
  console.log(`   walletAddress: ${walletAddress}`);
  
  const walletNativeTransfers = (heliusTx.nativeTransfers || []).filter(
    (t: any) => t.fromUserAccount === walletAddress || t.toUserAccount === walletAddress
  );
  
  console.log(`\n💰 Native transfers for wallet:`);
  walletNativeTransfers.forEach((transfer: any, idx: number) => {
    const amount = transfer.amount / 1e9;
    const direction = transfer.fromUserAccount === walletAddress ? 'OUT' : 'IN';
    console.log(`   [${idx + 1}] ${direction}: ${amount.toFixed(6)} SOL (from: ${transfer.fromUserAccount.substring(0, 8)}..., to: ${transfer.toUserAccount.substring(0, 8)}...)`);
  });
  
  const nativeOutTotal = walletNativeTransfers
    .filter((transfer: any) => transfer.fromUserAccount === walletAddress)
    .reduce((sum: number, transfer: any) => sum + transfer.amount / 1e9, 0);
  
  const nativeInTotal = walletNativeTransfers
    .filter((transfer: any) => transfer.toUserAccount === walletAddress)
    .reduce((sum: number, transfer: any) => sum + transfer.amount / 1e9, 0);
  
  const solDelta = nativeInTotal - nativeOutTotal;
  
  console.log(`\n📊 Calculated values:`);
  console.log(`   nativeOutTotal: ${nativeOutTotal.toFixed(6)} SOL`);
  console.log(`   nativeInTotal: ${nativeInTotal.toFixed(6)} SOL`);
  console.log(`   solDelta: ${solDelta.toFixed(6)} SOL`);
  
  // 4. Zkontroluj accountData
  let accountDataNativeChange = 0;
  if (heliusTx.accountData) {
    const walletAccountData = heliusTx.accountData.find(
      (acc: any) => acc.account === walletAddress
    );
    if (walletAccountData && walletAccountData.nativeBalanceChange) {
      accountDataNativeChange = walletAccountData.nativeBalanceChange / 1e9;
      console.log(`   accountData.nativeBalanceChange: ${accountDataNativeChange.toFixed(6)} SOL`);
    }
  }
  
  // 5. Vypočítej správný amountBase
  let correctAmountBase = 0;
  if (trade.side === 'buy') {
    // BUY: použij nativeOutTotal (kolik SOL jsme poslali)
    correctAmountBase = nativeOutTotal > 0 ? nativeOutTotal : Math.abs(solDelta);
    
    // Pokud je accountData výrazně větší, použij ho (ale to by mělo být netto, takže to není ideální)
    if (accountDataNativeChange < 0 && Math.abs(accountDataNativeChange) > correctAmountBase * 1.1) {
      console.log(`   ⚠️  accountData (${Math.abs(accountDataNativeChange).toFixed(6)} SOL) is larger than nativeOutTotal, but it's netto (includes fees)`);
    }
  } else {
    // SELL: použij nativeInTotal (kolik SOL jsme dostali)
    correctAmountBase = nativeInTotal > 0 ? nativeInTotal : Math.abs(solDelta);
  }
  
  // Pokud máme očekávanou hodnotu, použij ji
  if (EXPECTED_AMOUNT_BASE > 0 && Math.abs(correctAmountBase - EXPECTED_AMOUNT_BASE) > 0.1) {
    console.log(`\n⚠️  Calculated amountBase (${correctAmountBase.toFixed(6)} SOL) differs from expected (${EXPECTED_AMOUNT_BASE} SOL)`);
    console.log(`   Using expected value: ${EXPECTED_AMOUNT_BASE} SOL`);
    correctAmountBase = EXPECTED_AMOUNT_BASE;
  }
  
  console.log(`\n✅ Correct amountBase: ${correctAmountBase.toFixed(6)} SOL`);
  console.log(`   Current amountBase: ${Number(trade.amountBase).toFixed(6)} SOL`);
  console.log(`   Difference: ${(correctAmountBase - Number(trade.amountBase)).toFixed(6)} SOL`);
  
  // 6. Vypočítej novou cenu
  const correctPriceBasePerToken = correctAmountBase / Math.abs(Number(trade.amountToken));
  
  console.log(`\n📊 Updated values:`);
  console.log(`   amountBase: ${correctAmountBase.toFixed(6)} SOL`);
  console.log(`   priceBasePerToken: ${correctPriceBasePerToken.toFixed(8)} SOL/token`);
  
  // 7. Aktualizuj trade v databázi
  const { error } = await supabase
    .from(TABLES.TRADE)
    .update({
      amountBase: correctAmountBase.toString(),
      priceBasePerToken: correctPriceBasePerToken.toString(),
      updatedAt: new Date().toISOString(),
    })
    .eq('id', trade.id);
  
  if (error) {
    console.error(`❌ Failed to update trade:`, error);
    return;
  }
  
  console.log(`\n✅ Trade updated successfully!`);
  console.log(`   Trade ID: ${trade.id}`);
  console.log(`   New amountBase: ${correctAmountBase.toFixed(6)} SOL`);
  
  // 8. Enqueue wallet pro přepočet metrik
  try {
    const { WalletProcessingQueueRepository } = await import('../repositories/wallet-processing-queue.repository.js');
    const walletProcessingQueueRepo = new WalletProcessingQueueRepository();
    await walletProcessingQueueRepo.enqueue(trade.walletId);
    console.log(`   ✅ Enqueued wallet ${trade.walletId} for metrics recalculation.`);
  } catch (queueError: any) {
    console.warn(`⚠️  Failed to enqueue wallet for metrics recalculation: ${queueError.message}`);
  }
}

fixTradeAmount().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

