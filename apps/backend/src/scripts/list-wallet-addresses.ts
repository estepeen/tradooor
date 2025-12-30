import 'dotenv/config';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';

/**
 * List all wallet addresses from database.
 * Useful for manual import into Helius webhook.
 *
 * Usage:
 *   pnpm --filter backend helius:list-wallets
 */

const smartWalletRepo = new SmartWalletRepository();

async function main() {
  const { wallets } = await smartWalletRepo.findAll({ page: 1, pageSize: 10000 });

  console.log(`\n📋 Found ${wallets.length} wallets in database:\n`);

  // Print each address on new line (for easy copy-paste)
  for (const wallet of wallets) {
    console.log(wallet.address);
  }

  console.log(`\n✅ Total: ${wallets.length} addresses`);
  console.log('\nCopy-paste the addresses above into Helius webhook configuration.');
}

main().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
