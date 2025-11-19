import { Router } from 'express';
import { SolanaCollectorService } from '../services/solana-collector.service.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';

const router = Router();

const smartWalletRepo = new SmartWalletRepository();
const tradeRepo = new TradeRepository();
const tokenRepo = new TokenRepository();
const collectorService = new SolanaCollectorService(
  smartWalletRepo,
  tradeRepo,
  tokenRepo
);

/**
 * POST /api/webhooks/helius
 * 
 * Endpoint pro příjem webhook notifikací od Helius
 * Helius posílá POST request s transakcemi, když sledovaná wallet provede swap
 */
router.post('/helius', async (req, res) => {
  try {
    // Helius enhanced webhook posílá data v tomto formátu:
    // { accountData: [{ account: "wallet_address", ... }], transactions: [{ type: "SWAP", ... }] }
    console.log('📨 Received Helius webhook payload');
    console.log('   Payload keys:', Object.keys(req.body));
    console.log('   Payload sample:', JSON.stringify(req.body).substring(0, 500));

    const { transactions, accountData } = req.body;

    // Normalizuj formát - Helius enhanced webhook posílá { accountData: [...], transactions: [...] }
    let txList: any[] = [];
    if (transactions && Array.isArray(transactions)) {
      txList = transactions;
    } else if (Array.isArray(req.body)) {
      // Fallback: někdy Helius posílá přímo pole transakcí
      txList = req.body;
    }

    if (txList.length === 0) {
      console.warn('⚠️  Invalid webhook payload - no transactions found');
      console.log('   Full payload:', JSON.stringify(req.body, null, 2).substring(0, 1000));
      // Vrať 200, aby Helius neopakoval request
      return res.status(200).json({ success: false, error: 'No transactions in payload' });
    }

    console.log(`📨 Received Helius webhook: ${txList.length} transaction(s), ${accountData?.length || 0} account(s)`);

    // Vytvoř mapu account addresses -> wallet (pro rychlé vyhledávání)
    const accountMap = new Map<string, string>();
    if (accountData && Array.isArray(accountData)) {
      for (const account of accountData) {
        const accountAddr = account.account || account;
        if (accountAddr && typeof accountAddr === 'string') {
          accountMap.set(accountAddr, accountAddr);
        }
      }
    }

    // Získej všechny trackované wallet adresy z DB (pro rychlé vyhledávání)
    const allWallets = await smartWalletRepo.findAll({ page: 1, pageSize: 10000 });
    const trackedAddresses = new Set(allWallets.wallets.map(w => w.address.toLowerCase()));

    let processed = 0;
    let saved = 0;
    let skipped = 0;

    // Zpracuj každou transakci
    for (const tx of txList) {
      try {
        // Zkontroluj, jestli je to swap
        if (tx.type !== 'SWAP') {
          skipped++;
          continue;
        }

        // Najdi wallet podle adresy z transakce
        // Helius enhanced webhook posílá accountData s adresami účastníků
        let walletAddress: string | null = null;

        // 1. Zkus najít z accountData v payload
        if (accountData && Array.isArray(accountData)) {
          for (const account of accountData) {
            const accountAddr = account.account || account;
            if (accountAddr && typeof accountAddr === 'string') {
              if (trackedAddresses.has(accountAddr.toLowerCase())) {
                walletAddress = accountAddr;
                break;
              }
            }
          }
        }

        // 2. Zkus najít z accountData v transakci
        if (!walletAddress && tx.accountData && Array.isArray(tx.accountData)) {
          for (const account of tx.accountData) {
            const accountAddr = account.account || account;
            if (accountAddr && typeof accountAddr === 'string') {
              if (trackedAddresses.has(accountAddr.toLowerCase())) {
                walletAddress = accountAddr;
                break;
              }
            }
          }
        }

        // 3. Zkus najít z nativeTransfers
        if (!walletAddress && tx.nativeTransfers && Array.isArray(tx.nativeTransfers)) {
          for (const transfer of tx.nativeTransfers) {
            if (transfer.fromUserAccount && trackedAddresses.has(transfer.fromUserAccount.toLowerCase())) {
              walletAddress = transfer.fromUserAccount;
              break;
            }
            if (transfer.toUserAccount && trackedAddresses.has(transfer.toUserAccount.toLowerCase())) {
              walletAddress = transfer.toUserAccount;
              break;
            }
          }
        }

        // 4. Zkus najít z tokenTransfers
        if (!walletAddress && tx.tokenTransfers && Array.isArray(tx.tokenTransfers)) {
          for (const transfer of tx.tokenTransfers) {
            if (transfer.fromUserAccount && trackedAddresses.has(transfer.fromUserAccount.toLowerCase())) {
              walletAddress = transfer.fromUserAccount;
              break;
            }
            if (transfer.toUserAccount && trackedAddresses.has(transfer.toUserAccount.toLowerCase())) {
              walletAddress = transfer.toUserAccount;
              break;
            }
          }
        }

        if (!walletAddress) {
          console.warn(`⚠️  Could not find tracked wallet address for transaction ${tx.signature?.substring(0, 16) || 'unknown'}`);
          console.log(`   Transaction accountData:`, tx.accountData?.map((a: any) => a.account || a).join(', ') || 'none');
          skipped++;
          continue;
        }

        // Zpracuj transakci pomocí collector service
        const result = await collectorService.processWebhookTransaction(tx, walletAddress);
        
        if (result.saved) {
          saved++;
          console.log(`✅ Saved swap: ${tx.signature?.substring(0, 16) || 'unknown'}... for wallet ${walletAddress.substring(0, 8)}...`);
        } else {
          skipped++;
          console.log(`⏭️  Skipped swap: ${tx.signature?.substring(0, 16) || 'unknown'}... (${result.reason || 'duplicate'})`);
        }

        processed++;
      } catch (error: any) {
        console.error(`❌ Error processing webhook transaction ${tx.signature?.substring(0, 16) || 'unknown'}:`, error.message);
        console.error(`   Stack:`, error.stack?.split('\n').slice(0, 3).join('\n'));
        // Pokračuj s další transakcí
      }
    }

    console.log(`✅ Webhook processed: ${processed} transactions, ${saved} saved, ${skipped} skipped`);

    // Vrať 200 OK - Helius očekává úspěšnou odpověď
    res.status(200).json({
      success: true,
      processed,
      saved,
      skipped,
    });
  } catch (error: any) {
    console.error('❌ Error processing webhook:', error);
    console.error('   Stack:', error.stack?.split('\n').slice(0, 5).join('\n'));
    // I při chybě vrať 200, aby Helius neopakoval request
    res.status(200).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;

