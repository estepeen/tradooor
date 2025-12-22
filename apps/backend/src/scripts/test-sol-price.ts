import dotenv from 'dotenv';
import { prisma } from '../lib/prisma.js';
import { BinancePriceService } from '../services/binance-price.service.js';
import { SolPriceCacheService } from '../services/sol-price-cache.service.js';

dotenv.config();

/**
 * Test script pro kontrolu SOL ceny z Binance API a cache
 */
async function testSolPrice() {
  console.log('\n🔍 Testing SOL price fetching...\n');

  // 1. Test Binance API přímo
  console.log('1️⃣  Testing Binance API directly...');
  const binancePriceService = new BinancePriceService();
  try {
    const binancePrice = await binancePriceService.getCurrentSolPrice();
    console.log(`   ✅ Binance API: $${binancePrice.toFixed(2)} USD\n`);
  } catch (error: any) {
    console.error(`   ❌ Binance API failed: ${error?.message}\n`);
  }

  // 2. Zkontroluj cache v databázi
  console.log('2️⃣  Checking database cache...');
  try {
    const cache = await prisma.solPriceCache.findUnique({
      where: { id: 'current' },
    });

    if (cache) {
      const cacheAge = Date.now() - cache.updatedAt.getTime();
      const cacheAgeMinutes = Math.floor(cacheAge / (1000 * 60));
      console.log(`   ✅ Cache found:`);
      console.log(`      Price: $${cache.priceUsd.toFixed(2)} USD`);
      console.log(`      Source: ${cache.source}`);
      console.log(`      Updated: ${cache.updatedAt.toISOString()}`);
      console.log(`      Age: ${cacheAgeMinutes} minutes\n`);
    } else {
      console.log(`   ⚠️  No cache found in database\n`);
    }
  } catch (error: any) {
    console.error(`   ❌ Database error: ${error?.message}\n`);
  }

  // 3. Test SolPriceCacheService
  console.log('3️⃣  Testing SolPriceCacheService...');
  const solPriceCacheService = new SolPriceCacheService();
  try {
    const cachedPrice = await solPriceCacheService.getCurrentSolPrice();
    console.log(`   ✅ SolPriceCacheService: $${cachedPrice.toFixed(2)} USD\n`);
  } catch (error: any) {
    console.error(`   ❌ SolPriceCacheService failed: ${error?.message}\n`);
  }

  // 4. Test HTTP request na Binance API
  console.log('4️⃣  Testing Binance API HTTP request...');
  try {
    const response = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json() as { price: string; symbol: string };
    console.log(`   ✅ HTTP Request successful:`);
    console.log(`      Symbol: ${data.symbol}`);
    console.log(`      Price: $${parseFloat(data.price).toFixed(2)} USD\n`);
  } catch (error: any) {
    console.error(`   ❌ HTTP Request failed: ${error?.message}\n`);
  }

  console.log('✅ Test completed!\n');
  process.exit(0);
}

testSolPrice().catch((error) => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});

