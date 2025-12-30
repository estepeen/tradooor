import 'dotenv/config';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';

/**
 * Sync wallet addresses from database to Helius webhooks.
 *
 * Helius free tier allows max 25 addresses per webhook.
 * This script will create/update multiple webhooks as needed.
 *
 * Required env variables:
 * - HELIUS_API_KEY: Your Helius API key
 * - HELIUS_WEBHOOK_URL: Your webhook URL (e.g., https://tradooor.stepanpanek.cz/api/webhooks/helius)
 *
 * Optional:
 * - HELIUS_WEBHOOK_IDS: Comma-separated list of existing webhook IDs to update
 *
 * Usage:
 *   pnpm --filter backend helius:sync
 */

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_WEBHOOK_URL = process.env.HELIUS_WEBHOOK_URL || 'https://tradooor.stepanpanek.cz/api/webhooks/helius';
const HELIUS_WEBHOOK_IDS = process.env.HELIUS_WEBHOOK_IDS?.split(',').filter(Boolean) || [];

// Helius API might allow more than 25 addresses via API (UI limit vs API limit)
// We'll try with all addresses first, then fall back to chunking if it fails
const MAX_ADDRESSES_PER_WEBHOOK = 100; // Try higher limit first

const smartWalletRepo = new SmartWalletRepository();

interface HeliusWebhook {
  webhookID: string;
  wallet: string;
  webhookURL: string;
  transactionTypes: string[];
  accountAddresses: string[];
  webhookType: string;
}

async function getExistingWebhooks(): Promise<HeliusWebhook[]> {
  const response = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`);
  if (!response.ok) {
    throw new Error(`Failed to get webhooks: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<HeliusWebhook[]>;
}

async function createWebhook(addresses: string[], index: number): Promise<string> {
  console.log(`📝 Creating webhook #${index + 1} with ${addresses.length} addresses...`);

  const response = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      webhookURL: HELIUS_WEBHOOK_URL,
      transactionTypes: ['SWAP'],
      accountAddresses: addresses,
      webhookType: 'enhanced',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create webhook: ${response.status} ${error}`);
  }

  const result = await response.json() as { webhookID: string };
  console.log(`   ✅ Created webhook: ${result.webhookID}`);
  return result.webhookID;
}

async function updateWebhook(webhookId: string, addresses: string[]): Promise<void> {
  console.log(`📝 Updating webhook ${webhookId} with ${addresses.length} addresses...`);

  const response = await fetch(`https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${HELIUS_API_KEY}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      webhookURL: HELIUS_WEBHOOK_URL,
      transactionTypes: ['SWAP'],
      accountAddresses: addresses,
      webhookType: 'enhanced',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to update webhook ${webhookId}: ${response.status} ${error}`);
  }

  console.log(`   ✅ Updated webhook ${webhookId}`);
}

async function deleteWebhook(webhookId: string): Promise<void> {
  console.log(`🗑️  Deleting webhook ${webhookId}...`);

  const response = await fetch(`https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${HELIUS_API_KEY}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const error = await response.text();
    console.warn(`   ⚠️  Failed to delete webhook ${webhookId}: ${response.status} ${error}`);
  } else {
    console.log(`   ✅ Deleted webhook ${webhookId}`);
  }
}

async function tryCreateSingleWebhook(addresses: string[]): Promise<string | null> {
  console.log(`📝 Trying to create single webhook with all ${addresses.length} addresses...`);

  try {
    const response = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webhookURL: HELIUS_WEBHOOK_URL,
        transactionTypes: ['SWAP'],
        accountAddresses: addresses,
        webhookType: 'enhanced',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.log(`   ⚠️  Single webhook failed: ${response.status} ${error}`);
      return null;
    }

    const result = await response.json() as { webhookID: string };
    console.log(`   ✅ Created single webhook with all addresses: ${result.webhookID}`);
    return result.webhookID;
  } catch (error: any) {
    console.log(`   ⚠️  Single webhook failed: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log('🚀 Syncing Helius webhooks...\n');

  if (!HELIUS_API_KEY) {
    console.error('❌ HELIUS_API_KEY is not set');
    process.exit(1);
  }

  // 1. Get all wallet addresses from DB
  const { wallets } = await smartWalletRepo.findAll({ page: 1, pageSize: 10000 });
  const addresses = wallets.map(w => w.address);

  console.log(`📋 Found ${addresses.length} wallets in database\n`);

  // 2. Get existing webhooks
  const existingWebhooks = await getExistingWebhooks();
  const ourWebhooks = existingWebhooks.filter(w => w.webhookURL === HELIUS_WEBHOOK_URL);

  console.log(`📡 Found ${existingWebhooks.length} total Helius webhooks`);
  console.log(`   ${ourWebhooks.length} are pointing to our URL\n`);

  // 3. Try to update existing webhook with all addresses first
  if (ourWebhooks.length > 0) {
    console.log(`📝 Updating existing webhook ${ourWebhooks[0].webhookID} with all ${addresses.length} addresses...`);
    try {
      await updateWebhook(ourWebhooks[0].webhookID, addresses);
      console.log('\n✅ Sync complete! All addresses in single webhook.');
      console.log(`   Webhook ID: ${ourWebhooks[0].webhookID}`);
      console.log(`   Total addresses: ${addresses.length}`);

      // Delete extra webhooks
      for (let i = 1; i < ourWebhooks.length; i++) {
        await deleteWebhook(ourWebhooks[i].webhookID);
      }
      return;
    } catch (error: any) {
      console.log(`   ⚠️  Failed to update with all addresses: ${error.message}`);
      console.log(`   Falling back to chunked approach...\n`);
    }
  } else {
    // Try creating single webhook with all addresses
    const singleId = await tryCreateSingleWebhook(addresses);
    if (singleId) {
      console.log('\n✅ Sync complete! All addresses in single webhook.');
      console.log(`   Webhook ID: ${singleId}`);
      console.log(`   Total addresses: ${addresses.length}`);
      console.log(`\n   Add to .env: HELIUS_WEBHOOK_IDS=${singleId}`);
      return;
    }
    console.log(`   Falling back to chunked approach...\n`);
  }

  // 4. Fallback: Split addresses into chunks
  console.log(`   Max ${MAX_ADDRESSES_PER_WEBHOOK} addresses per webhook`);
  console.log(`   Need ${Math.ceil(addresses.length / MAX_ADDRESSES_PER_WEBHOOK)} webhook(s)\n`);

  const chunks: string[][] = [];
  for (let i = 0; i < addresses.length; i += MAX_ADDRESSES_PER_WEBHOOK) {
    chunks.push(addresses.slice(i, i + MAX_ADDRESSES_PER_WEBHOOK));
  }

  // 5. Update/create webhooks
  const webhookIds: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    if (i < ourWebhooks.length) {
      // Update existing webhook
      await updateWebhook(ourWebhooks[i].webhookID, chunk);
      webhookIds.push(ourWebhooks[i].webhookID);
    } else {
      // Create new webhook
      const newId = await createWebhook(chunk, i);
      webhookIds.push(newId);
    }
  }

  // 6. Delete extra webhooks (if we now need fewer)
  for (let i = chunks.length; i < ourWebhooks.length; i++) {
    await deleteWebhook(ourWebhooks[i].webhookID);
  }

  console.log('\n✅ Sync complete!');
  console.log(`   Active webhooks: ${webhookIds.length}`);
  console.log(`   Total addresses: ${addresses.length}`);
  console.log(`\n   Webhook IDs: ${webhookIds.join(', ')}`);
  console.log(`\n   Add to .env: HELIUS_WEBHOOK_IDS=${webhookIds.join(',')}`);
}

main().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
