import 'dotenv/config';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';

async function main() {
  const walletAddress = process.argv[2];
  if (!walletAddress) {
    console.error('Usage: pnpm --filter @solbot/backend trades:print <WALLET_ADDRESS>');
    process.exit(1);
  }

  const smartWalletRepo = new SmartWalletRepository();
  const tradeRepo = new TradeRepository();

  const wallet = await smartWalletRepo.findByAddress(walletAddress);
  if (!wallet) {
    console.error('Wallet not found');
    process.exit(1);
  }

  const { trades } = await tradeRepo.findByWalletId(wallet.id, { page: 1, pageSize: 20 });
  trades.forEach((trade: any, idx: number) => {
    console.log(
      `${idx + 1}. ${trade.id} token=${trade.tokenId} side=${trade.side} amountToken=${trade.amountToken} amountBase=${trade.amountBase} price=${trade.priceBasePerToken}`
    );
  });
}

main();


