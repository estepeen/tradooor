/**
 * Check wallet trades and verify SOL conversion
 * 
 * Usage: pnpm --filter backend check:wallet-trades <WALLET_ADDRESS>
 */

import { prisma } from '../lib/prisma.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { BinancePriceService } from '../services/binance-price.service.js';
import { safeDecimalToNumber } from '../lib/prisma.js';

async function checkWalletTrades(walletAddress: string) {
  console.log(`🔍 Checking trades for wallet: ${walletAddress}\n`);

  // Find wallet by address
  const wallet = await prisma.smartWallet.findUnique({
    where: { address: walletAddress },
    select: {
      id: true,
      address: true,
      label: true,
    },
  });

  if (!wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }

  console.log(`✅ Found wallet: ${wallet.label || wallet.address}`);
  console.log(`   Wallet ID: ${wallet.id}\n`);

  // Get recent trades
  const tradeRepo = new TradeRepository();
  const result = await tradeRepo.findByWalletId(wallet.id, {
    page: 1,
    pageSize: 20,
  });

  console.log(`📊 Found ${result.total} total trades, showing first ${result.trades.length}:\n`);

  const binancePriceService = new BinancePriceService();

  // Check each trade
  for (const trade of result.trades.slice(0, 10)) {
    const meta = (trade.meta as any) || {};
    const baseToken = meta?.baseToken || 'SOL';
    const valuationSource = meta?.valuationSource;
    const source = meta?.source || '';
    
    const amountBase = safeDecimalToNumber(trade.amountBase);
    const amountToken = safeDecimalToNumber(trade.amountToken);
    const priceBasePerToken = safeDecimalToNumber(trade.priceBasePerToken);
    const valueUsd = safeDecimalToNumber(trade.valueUsd);
    
    console.log(`📦 Trade ${trade.id.substring(0, 16)}...`);
    console.log(`   Side: ${trade.side}`);
    console.log(`   Token: ${trade.Token?.symbol || trade.tokenId}`);
    console.log(`   Amount Token: ${amountToken.toFixed(2)}`);
    console.log(`   Amount Base: ${amountBase.toFixed(6)} (baseToken: ${baseToken})`);
    console.log(`   Price Base/Token: ${priceBasePerToken.toFixed(8)}`);
    console.log(`   Value USD: ${valueUsd?.toFixed(2) || 'null'}`);
    console.log(`   Valuation Source: ${valuationSource || 'none'}`);
    console.log(`   Source: ${source || 'none'}`);
    
    // Calculate amountBaseSol
    let amountBaseSol = amountBase;
    const tradeTimestamp = new Date(trade.timestamp);
    
    try {
      const solPriceUsd = await binancePriceService.getSolPriceAtTimestamp(tradeTimestamp);
      if (solPriceUsd && solPriceUsd > 0) {
        if (valuationSource) {
          // amountBase is in USD
          amountBaseSol = amountBase / solPriceUsd;
          console.log(`   ⚠️  amountBase is in USD (valuationSource) → converting to SOL`);
          console.log(`      SOL price at time: $${solPriceUsd.toFixed(2)}`);
          console.log(`      amountBaseSol: ${amountBaseSol.toFixed(6)} SOL`);
        } else if (baseToken === 'USDC' || baseToken === 'USDT') {
          // amountBase is in USDC/USDT (1:1 USD)
          amountBaseSol = amountBase / solPriceUsd;
          console.log(`   ⚠️  amountBase is in ${baseToken} (1:1 USD) → converting to SOL`);
          console.log(`      SOL price at time: $${solPriceUsd.toFixed(2)}`);
          console.log(`      amountBaseSol: ${amountBaseSol.toFixed(6)} SOL`);
        } else if (baseToken === 'SOL' || baseToken === 'WSOL') {
          // amountBase is already in SOL
          amountBaseSol = amountBase;
          console.log(`   ✅ amountBase is already in SOL`);
          console.log(`      amountBaseSol: ${amountBaseSol.toFixed(6)} SOL`);
        } else {
          console.log(`   ⚠️  Unknown baseToken: ${baseToken}, using amountBase as-is`);
        }
      } else {
        console.log(`   ❌ Failed to get SOL price`);
      }
    } catch (error: any) {
      console.log(`   ❌ Error converting: ${error.message}`);
    }
    
    // Verify calculation
    if (valueUsd && amountBaseSol) {
      const expectedSolPrice = valueUsd / amountBaseSol;
      console.log(`   📊 Verification:`);
      console.log(`      valueUsd: $${valueUsd.toFixed(2)}`);
      console.log(`      amountBaseSol: ${amountBaseSol.toFixed(6)} SOL`);
      console.log(`      Implied SOL price: $${expectedSolPrice.toFixed(2)}`);
    }
    
    console.log('');
  }

  // Summary
  console.log(`\n📈 Summary:`);
  console.log(`   Total trades: ${result.total}`);
  console.log(`   Sample size: ${result.trades.length}`);
  
  // Count by baseToken
  const baseTokenCounts = new Map<string, number>();
  const valuationSourceCounts = new Map<string, number>();
  
  for (const trade of result.trades) {
    const meta = (trade.meta as any) || {};
    const baseToken = meta?.baseToken || 'SOL';
    const valuationSource = meta?.valuationSource || 'none';
    
    baseTokenCounts.set(baseToken, (baseTokenCounts.get(baseToken) || 0) + 1);
    valuationSourceCounts.set(valuationSource, (valuationSourceCounts.get(valuationSource) || 0) + 1);
  }
  
  console.log(`\n   Base tokens:`);
  for (const [token, count] of baseTokenCounts.entries()) {
    console.log(`      ${token}: ${count}`);
  }
  
  console.log(`\n   Valuation sources:`);
  for (const [source, count] of valuationSourceCounts.entries()) {
    console.log(`      ${source}: ${count}`);
  }
}

const walletAddress = process.argv[2];
if (!walletAddress) {
  console.error('Usage: tsx check-wallet-trades.ts <WALLET_ADDRESS>');
  process.exit(1);
}

checkWalletTrades(walletAddress)
  .then(() => {
    console.log('\n✅ Done');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });

