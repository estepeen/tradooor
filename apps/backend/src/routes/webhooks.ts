import { Router } from 'express';
import { SolanaCollectorService } from '../services/solana-collector.service.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { WalletProcessingQueueRepository } from '../repositories/wallet-processing-queue.repository.js';

const router = Router();

const smartWalletRepo = new SmartWalletRepository();
const tradeRepo = new TradeRepository();
const tokenRepo = new TokenRepository();
const walletQueueRepo = new WalletProcessingQueueRepository();
const collectorService = new SolanaCollectorService(
  smartWalletRepo,
  tradeRepo,
  tokenRepo,
  walletQueueRepo
);

/**
 * Function to process Helius webhook payload
 * Can be called from both router and index.ts
 */
export async function processHeliusWebhook(body: any) {
  try {
    console.log('📨 ===== WEBHOOK PROCESSING STARTED =====');
    console.log(`   Time: ${new Date().toISOString()}`);
    console.log('   Body keys:', Object.keys(body || {}));

    // Helius enhanced webhook sends data in this format:
    // { accountData: [{ account: "wallet_address", ... }], transactions: [{ type: "SWAP", ... }] }
    const { transactions, accountData } = body;

    // Normalize format - Helius enhanced webhook sends { accountData: [...], transactions: [...] }
    let txList: any[] = [];
    if (transactions && Array.isArray(transactions)) {
      txList = transactions;
    } else if (Array.isArray(body)) {
      // Fallback: sometimes Helius sends array of transactions directly
      txList = body;
    }

    if (txList.length === 0) {
      console.warn('⚠️  Invalid webhook payload - no transactions found');
      console.log('   Payload keys:', Object.keys(body || {}));
      return { processed: 0, saved: 0, skipped: 0 };
    }

    console.log(`📨 Received Helius webhook: ${txList.length} transaction(s), ${accountData?.length || 0} account(s)`);

    const backgroundStartTime = Date.now();
    
    // Get all tracked wallet addresses from DB (for fast lookup)
    const allWallets = await smartWalletRepo.findAll({ page: 1, pageSize: 10000 });
    const trackedAddresses = new Set(allWallets.wallets.map(w => w.address.toLowerCase()));

    let processed = 0;
    let saved = 0;
    let skipped = 0;

    // Process each transaction
    for (const tx of txList) {
      try {
        // Check if it's a swap
        if (tx.type !== 'SWAP') {
          skipped++;
          continue;
        }

        // Find wallet by address from transaction
        // Helius enhanced webhook sends accountData with participant addresses
        let walletAddress: string | null = null;

        // 1. Try to find from accountData in payload
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

        // 2. Try to find from accountData in transaction
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

        // 3. Try to find from nativeTransfers
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

        // 4. Try to find from tokenTransfers
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

        // Process transaction using collector service
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
        // Change to warn - some errors (e.g. incomplete data) are not critical
        console.warn(`⚠️  Error processing webhook transaction ${tx.signature?.substring(0, 16) || 'unknown'}:`, error.message);
        if (error.stack) {
          console.warn(`   Stack:`, error.stack.split('\n').slice(0, 3).join('\n'));
        }
        // Continue with next transaction
      }
    }

    const backgroundTime = Date.now() - backgroundStartTime;
    console.log(`✅ Webhook processed (background): ${processed} transactions, ${saved} saved, ${skipped} skipped (took ${backgroundTime}ms)`);
    
    return { processed, saved, skipped };
  } catch (error: any) {
    console.error('❌ Error processing webhook in background:', error);
    if (error.stack) {
      console.error('   Stack:', error.stack.split('\n').slice(0, 5).join('\n'));
    }
    throw error;
  }
}

/**
 * Process QuickNode webhook payload (RPC-style block/transactions structure).
 * Expects payload similar to:
 * {
 *   data: [{
 *     blockTime: number;
 *     transactions: [{ meta, transaction, version }, ...]
 *   }]
 * }
 */
export async function processQuickNodeWebhook(body: any) {
  try {
    console.log('📨 ===== QUICKNODE WEBHOOK PROCESSING STARTED =====');
    console.log(`   Time: ${new Date().toISOString()}`);
    console.log('   Body keys:', Object.keys(body || {}));
    console.log('   Body type:', Array.isArray(body) ? 'array' : typeof body);
    
    // Debug: log structure of body
    if (body?.data) {
      console.log('   body.data is array?', Array.isArray(body.data));
      console.log('   body.data length:', body.data?.length);
      if (Array.isArray(body.data) && body.data.length > 0) {
        console.log('   body.data[0] keys:', Object.keys(body.data[0] || {}));
      }
    }
    if (Array.isArray(body) && body.length > 0) {
      console.log('   body[0] keys:', Object.keys(body[0] || {}));
      if (body[0]?.block) {
        console.log('   body[0].block keys:', Object.keys(body[0].block || {}));
      }
    }

    // Try multiple payload formats that QuickNode might use
    let blockTime: number | undefined;
    let txList: any[] = [];

    // Format 1: Array of blocks [{ block: { blockTime, ... }, transactions: [...] }, ...]
    if (Array.isArray(body) && body.length > 0) {
      const firstBlock = body[0];
      // Check if it's a block structure
      if (firstBlock?.block && firstBlock?.transactions) {
        blockTime = firstBlock.block.blockTime;
        txList = Array.isArray(firstBlock.transactions) ? firstBlock.transactions : [];
        // Also check other blocks in the array
        for (let i = 1; i < body.length; i++) {
          if (body[i]?.transactions && Array.isArray(body[i].transactions)) {
            txList.push(...body[i].transactions);
          }
        }
      }
      // Format 1b: Array of transactions directly (fallback)
      else if (!firstBlock?.block && !firstBlock?.transactions) {
        // Might be array of transactions directly
        txList = body;
      }
    }
    // Format 2: { data: [{ blockTime, transactions: [...] }] }
    else if (Array.isArray(body?.data) && body.data.length > 0) {
      const firstEntry = body.data[0];
      blockTime = firstEntry?.blockTime || firstEntry?.block?.blockTime;
      txList = Array.isArray(firstEntry?.transactions) ? firstEntry.transactions : [];
    }
    // Format 3: { blockTime, transactions: [...] } (direct)
    else if (body?.transactions && Array.isArray(body.transactions)) {
      blockTime = body.blockTime || body.block?.blockTime;
      txList = body.transactions;
    }
    // Format 4: { result: { blockTime, transactions: [...] } }
    else if (body?.result?.transactions && Array.isArray(body.result.transactions)) {
      blockTime = body.result.blockTime || body.result.block?.blockTime;
      txList = body.result.transactions;
    }

    console.log(`   Found ${txList.length} transaction(s), blockTime=${blockTime ?? 'n/a'}`);

    if (txList.length === 0) {
      console.warn('⚠️  Invalid QuickNode webhook payload - no transactions found');
      console.log('   Full body structure (first 500 chars):', JSON.stringify(body).substring(0, 500));
      return { processed: 0, saved: 0, skipped: 0 };
    }

    console.log(
      `📨 Received QuickNode webhook: ${txList.length} transaction(s) at blockTime=${blockTime ?? 'n/a'}`
    );

    const backgroundStartTime = Date.now();

    // Get all tracked wallet addresses from DB (for fast lookup)
    const allWallets = await smartWalletRepo.findAll({ page: 1, pageSize: 10000 });
    const trackedAddresses = new Set(allWallets.wallets.map(w => w.address.toLowerCase()));

    let processed = 0;
    let saved = 0;
    let skipped = 0;

    for (const tx of txList) {
      try {
        // Early filtering: QuickNode Streams/QuickAlerts may send different formats
        // Check if this is a valid RPC-style transaction (has transaction.message and meta)
        const message = tx.transaction?.message;
        const meta = tx.meta;
        
        // Skip if not in expected format (silently - too many to log)
        if (!message || !meta) {
          skipped++;
          continue;
        }
        
        // Quick check: if transaction has 'raw' or 'wallets' keys, it's likely a different format
        // (QuickNode Streams might send enriched data, not raw RPC format)
        if (tx.raw || tx.wallets) {
          skipped++;
          continue;
        }

        const candidateWallets = new Set<string>();

        // 1) From accountKeys
        for (const k of message.accountKeys || []) {
          const pk = typeof k === 'string' ? k : k?.pubkey;
          if (!pk) continue;
          const lower = pk.toLowerCase();
          if (trackedAddresses.has(lower)) {
            candidateWallets.add(pk);
          }
        }

        // 2) From token balances (owners)
        const addOwnersFrom = (arr: any[]) => {
          for (const b of arr || []) {
            const owner: string | undefined = b.owner;
            if (!owner) continue;
            const lower = owner.toLowerCase();
            if (trackedAddresses.has(lower)) {
              candidateWallets.add(owner);
            }
          }
        };
        addOwnersFrom(meta.preTokenBalances || []);
        addOwnersFrom(meta.postTokenBalances || []);

        // Early exit if no tracked wallets involved (silently - too many to log)
        if (candidateWallets.size === 0) {
          skipped++;
          continue;
        }

        // Process tx separately for each tracked wallet involved
        for (const walletAddress of candidateWallets) {
          const result = await collectorService.processQuickNodeTransaction(
            tx,
            walletAddress,
            blockTime
          );

          if (result.saved) {
            saved++;
            // Only log saved trades (important events)
            console.log(
              `✅ [QuickNode] Saved swap: ${
                tx.transaction?.signatures?.[0]?.substring(0, 16) || 'unknown'
              }... for wallet ${walletAddress.substring(0, 8)}...`
            );
          } else {
            skipped++;
            // Only log non-duplicate skips with important reasons (not "not a swap" - too common)
            if (result.reason && result.reason !== 'duplicate' && result.reason !== 'not a swap') {
              console.log(
                `⏭️  [QuickNode] Skipped: ${
                  tx.transaction?.signatures?.[0]?.substring(0, 16) || 'unknown'
                }... (${result.reason})`
              );
            }
          }

          processed++;
        }
      } catch (error: any) {
        console.warn(
          `⚠️  Error processing QuickNode webhook transaction ${
            tx.transaction?.signatures?.[0]?.substring(0, 16) || 'unknown'
          }:`,
          error.message
        );
      }
    }

    const backgroundTime = Date.now() - backgroundStartTime;
    console.log(
      `✅ QuickNode webhook processed: ${processed} logical transaction(s), ${saved} saved, ${skipped} skipped (took ${backgroundTime}ms)`
    );

    return { processed, saved, skipped };
  } catch (error: any) {
    console.error('❌ Error processing QuickNode webhook in background:', error);
    if (error.stack) {
      console.error('   Stack:', error.stack.split('\n').slice(0, 5).join('\n'));
    }
    throw error;
  }
}

/**
 * GET /api/webhooks/helius/test
 * Test endpoint - checks if webhook endpoint is working
 */
router.get('/helius/test', (req, res) => {
  res.json({
    success: true,
    message: 'Webhook endpoint is working!',
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/webhooks/helius/test-minimal
 * Minimal test endpoint - responds immediately without any processing
 * Use for debugging timeouts
 */
router.post('/helius/test-minimal', (req, res) => {
  console.log('📨 MINIMAL TEST WEBHOOK HIT at', new Date().toISOString());
  console.log('   IP:', req.ip || req.headers['x-forwarded-for']);
  console.log('   Headers:', JSON.stringify(req.headers).substring(0, 200));
  
  // Respond immediately - no processing
  res.status(200).json({ ok: true, message: 'minimal test ok' });
});

/**
 * POST /api/webhooks/helius
 * 
 * Endpoint to receive webhook notifications from Helius
 * Helius sends POST request with transactions when tracked wallet performs a swap
 * 
 * IMPORTANT: Responds immediately (200 OK) and processes asynchronously in background,
 * to avoid timeouts from Helius (Helius has timeout ~5-10 seconds)
 */
router.post('/helius', (req, res) => {
  // IMPORTANT: Respond to Helius immediately (200 OK) BEFORE any processing
  // Helius has timeout ~5-10 seconds, so we must respond as quickly as possible
  const startTime = Date.now();
  
  // Logging for debugging - IP address, headers, etc.
  const clientIp = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  
  // Respond immediately - before any processing
  res.status(200).json({
    success: true,
    message: 'Webhook received, processing in background',
    responseTimeMs: Date.now() - startTime,
  });

  // Processing happens asynchronously in background (doesn't block response)
  setImmediate(async () => {
    try {
      console.log('📨 ===== WEBHOOK REQUEST RECEIVED (FROM ROUTER) =====');
      console.log(`   Time: ${new Date().toISOString()}`);
      console.log(`   IP: ${clientIp}`);
      console.log(`   User-Agent: ${req.headers['user-agent'] || 'unknown'}`);
      
      await processHeliusWebhook(req.body);
    } catch (error: any) {
      console.error('❌ Error processing webhook in background:', error);
      if (error.stack) {
        console.error('   Stack:', error.stack.split('\n').slice(0, 5).join('\n'));
      }
    }
  });
});

/**
 * GET /api/webhooks/quicknode/test
 * Test endpoint - checks if QuickNode webhook endpoint is working
 */
router.get('/quicknode/test', (req, res) => {
  res.json({
    success: true,
    message: 'QuickNode webhook endpoint is working!',
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/webhooks/quicknode
 *
 * Endpoint to receive webhook notifications from QuickNode Streams / QuickAlerts.
 * Responds immediately and processes block/transactions in background.
 */
router.post('/quicknode', (req, res) => {
  const startTime = Date.now();

  const clientIp = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;

  res.status(200).json({
    success: true,
    message: 'QuickNode webhook received, processing in background',
    responseTimeMs: Date.now() - startTime,
  });

  setImmediate(async () => {
    try {
      console.log('📨 ===== QUICKNODE WEBHOOK REQUEST RECEIVED (FROM ROUTER) =====');
      console.log(`   Time: ${new Date().toISOString()}`);
      console.log(`   IP: ${clientIp}`);
      console.log(`   User-Agent: ${req.headers['user-agent'] || 'unknown'}`);

      // Parse Buffer to JSON if needed
      let body = req.body;
      if (Buffer.isBuffer(body)) {
        body = JSON.parse(body.toString('utf8'));
      } else if (typeof body === 'object' && body.type === 'Buffer' && Array.isArray(body.data)) {
        // Handle case where Buffer was serialized as JSON
        body = JSON.parse(Buffer.from(body.data).toString('utf8'));
      }

      await processQuickNodeWebhook(body);
    } catch (error: any) {
      console.error('❌ Error processing QuickNode webhook in background:', error);
      if (error.stack) {
        console.error('   Stack:', error.stack.split('\n').slice(0, 5).join('\n'));
      }
    }
  });
});

export default router;

