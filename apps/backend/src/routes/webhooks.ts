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
    // Helius webhook payload může mít různé formáty
    // Enhanced webhook: { accountData: [...], transactions: [...] }
    // Nebo: { webhookType: 'enhanced', data: [...] }
    const { transactions, accountData, data, webhookType } = req.body;

    // Normalizuj formát - Helius může poslat data v různých formátech
    let txList: any[] = [];
    if (transactions && Array.isArray(transactions)) {
      txList = transactions;
    } else if (data && Array.isArray(data)) {
      txList = data;
    } else if (Array.isArray(req.body)) {
      // Někdy Helius posílá přímo pole transakcí
      txList = req.body;
    }

    if (txList.length === 0) {
      console.warn('⚠️  Invalid webhook payload - no transactions found');
      console.log('   Payload keys:', Object.keys(req.body));
      // Vrať 200, aby Helius neopakoval request
      return res.status(200).json({ success: false, error: 'No transactions in payload' });
    }

    console.log(`📨 Received Helius webhook: ${txList.length} transaction(s)`);

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
        // Helius posílá accountData s informacemi o účtech zapojených do transakce
        let walletAddress: string | null = null;

        // Zkus najít wallet adresu z accountData (pokud je v payload)
        if (accountData && Array.isArray(accountData)) {
          for (const account of accountData) {
            const accountAddr = account.account || account;
            const wallet = await smartWalletRepo.findByAddress(accountAddr);
            if (wallet) {
              walletAddress = accountAddr;
              break;
            }
          }
        }

        // Pokud jsme nenašli wallet z accountData, zkus najít z nativeTransfers nebo tokenTransfers
        if (!walletAddress) {
          if (tx.nativeTransfers && tx.nativeTransfers.length > 0) {
            for (const transfer of tx.nativeTransfers) {
              const wallet = await smartWalletRepo.findByAddress(transfer.fromUserAccount);
              if (wallet) {
                walletAddress = transfer.fromUserAccount;
                break;
              }
              const wallet2 = await smartWalletRepo.findByAddress(transfer.toUserAccount);
              if (wallet2) {
                walletAddress = transfer.toUserAccount;
                break;
              }
            }
          }

          if (!walletAddress && tx.tokenTransfers && tx.tokenTransfers.length > 0) {
            for (const transfer of tx.tokenTransfers) {
              const wallet = await smartWalletRepo.findByAddress(transfer.fromUserAccount);
              if (wallet) {
                walletAddress = transfer.fromUserAccount;
                break;
              }
              const wallet2 = await smartWalletRepo.findByAddress(transfer.toUserAccount);
              if (wallet2) {
                walletAddress = transfer.toUserAccount;
                break;
              }
            }
          }

          // Zkus najít z accountData v transakci
          if (!walletAddress && tx.accountData && Array.isArray(tx.accountData)) {
            for (const account of tx.accountData) {
              const accountAddr = account.account || account;
              const wallet = await smartWalletRepo.findByAddress(accountAddr);
              if (wallet) {
                walletAddress = accountAddr;
                break;
              }
            }
          }
        }

        if (!walletAddress) {
          console.warn(`⚠️  Could not find wallet address for transaction ${tx.signature?.substring(0, 16) || 'unknown'}`);
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
    // I při chybě vrať 200, aby Helius neopakoval request
    res.status(200).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;

