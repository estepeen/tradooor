import 'dotenv/config';
import { supabase, TABLES } from '../lib/supabase.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';

const walletAddress = process.argv[2];
const daysArg = process.argv[3];

if (!walletAddress) {
  console.error('Usage: pnpm --filter backend debug:large-trades <walletAddress> [days]');
  process.exit(1);
}

const DAYS = daysArg ? parseInt(daysArg, 10) : 30;

async function main() {
  const walletRepo = new SmartWalletRepository();
  const wallet = await walletRepo.findByAddress(walletAddress);
  if (!wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }

  const since = new Date();
  since.setDate(since.getDate() - DAYS);

  const { data, error } = await supabase
    .from(TABLES.TRADE)
    .select('id, txSignature, side, valueUsd, amountBase, amountToken, priceBasePerToken, meta, timestamp')
    .eq('walletId', wallet.id)
    .gte('timestamp', since.toISOString())
    .order('valueUsd', { ascending: false })
    .limit(50);

  if (error) {
    throw new Error(`Failed to fetch trades: ${error.message}`);
  }

  console.log(`Top trades for wallet ${wallet.address} in last ${DAYS} days (ordered by valueUsd):`);
  (data || []).forEach((trade: any, index: number) => {
    console.log(
      `${index + 1}. ${trade.id} ${trade.side.toUpperCase()} valueUsd=${trade.valueUsd} amountBase=${trade.amountBase} baseToken=${trade.meta?.baseToken} valuation=${trade.meta?.valuationSource}`
    );
  });
}

main().catch((error) => {
  console.error('❌ Script failed:', error.message);
  process.exit(1);
});

