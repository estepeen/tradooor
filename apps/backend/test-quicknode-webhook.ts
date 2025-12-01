/**
 * Test script for QuickNode webhook endpoint
 * 
 * Usage:
 *   pnpm tsx apps/backend/test-quicknode-webhook.ts
 * 
 * This sends a minimal QuickNode payload to test if the endpoint accepts it
 * without PayloadTooLargeError.
 */

const API_URL = process.env.API_URL || 'http://localhost:3001';
const WEBHOOK_URL = `${API_URL}/api/webhooks/quicknode`;

// Minimal QuickNode payload structure (based on the JSON you provided earlier)
const testPayload = {
  data: [
    {
      blockHeight: 383787357,
      blockTime: 1764598177,
      blockhash: 'test-blockhash-123',
      previousBlockhash: 'test-prev-blockhash-456',
      parentSlot: 383770578,
      rewards: [],
      transactions: [
        {
          meta: {
            err: null,
            fee: 5000,
            preBalances: [1000000000, 500000000],
            postBalances: [995000000, 505000000],
            preTokenBalances: [],
            postTokenBalances: [],
          },
          transaction: {
            message: {
              accountKeys: [
                {
                  pubkey: '11111111111111111111111111111111',
                  signer: true,
                  source: 'transaction',
                  writable: true,
                },
              ],
              instructions: [
                {
                  parsed: {
                    info: {
                      destination: '22222222222222222222222222222222',
                      lamports: 5000000,
                      source: '11111111111111111111111111111111',
                    },
                    type: 'transfer',
                  },
                  program: 'system',
                  programId: '11111111111111111111111111111111',
                },
              ],
            },
            signatures: ['test-signature-123'],
          },
          version: 'legacy',
        },
      ],
    },
  ],
};

async function testQuickNodeWebhook() {
  console.log('🧪 Testing QuickNode webhook endpoint...');
  console.log(`   URL: ${WEBHOOK_URL}`);
  console.log(`   Payload size: ${JSON.stringify(testPayload).length} bytes`);

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(testPayload),
    });

    const responseText = await response.text();
    let responseJson: any;
    try {
      responseJson = JSON.parse(responseText);
    } catch {
      responseJson = { raw: responseText };
    }

    console.log(`\n📊 Response:`);
    console.log(`   Status: ${response.status} ${response.statusText}`);
    console.log(`   Body:`, JSON.stringify(responseJson, null, 2));

    if (response.status === 200) {
      console.log('\n✅ SUCCESS: Endpoint accepted the payload!');
      console.log('   Check backend logs for processing details.');
      return true;
    } else {
      console.log('\n❌ FAILED: Endpoint returned non-200 status');
      return false;
    }
  } catch (error: any) {
    console.error('\n❌ ERROR:', error.message);
    if (error.stack) {
      console.error('   Stack:', error.stack.split('\n').slice(0, 3).join('\n'));
    }
    return false;
  }
}

// Run test
testQuickNodeWebhook()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

