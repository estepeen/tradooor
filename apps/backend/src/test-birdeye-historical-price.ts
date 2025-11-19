import dotenv from 'dotenv';
import { TokenPriceService } from './services/token-price.service.js';

// Načti .env soubor
dotenv.config();

async function testBirdeyeHistoricalPrice() {
  const tokenPriceService = new TokenPriceService();
  
  console.log('🔍 Testing Birdeye API historical price for TRUMP and PUMP tokens...\n');
  
  // Mint adresy
  const trumpMint = '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN';
  // PUMP token mint address - možná je to program address, ne token mint?
  // Zkusíme najít správnou mint adresu
  const pumpMint = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn';
  
  console.log(`\n🔍 Testing with mint addresses:`);
  console.log(`   TRUMP: ${trumpMint}`);
  console.log(`   PUMP: ${pumpMint}`);
  console.log(`   Note: PUMP mint address might be incorrect or token might not exist in Birdeye\n`);
  
  // Test 1: Aktuální cena TRUMP
  console.log('1️⃣ Testing current price (TRUMP)...');
  const trumpCurrentPrice = await tokenPriceService.getTokenPrice(trumpMint);
  console.log(`   Current TRUMP price: $${trumpCurrentPrice}\n`);
  
  // Počkej chvíli před dalším requestem (rate limiter by měl to řešit, ale pro jistotu)
  await new Promise(resolve => setTimeout(resolve, 200));
  
  // Test 2: Aktuální cena PUMP
  console.log('2️⃣ Testing current price (PUMP)...');
  const pumpCurrentPrice = await tokenPriceService.getTokenPrice(pumpMint);
  console.log(`   Current PUMP price: $${pumpCurrentPrice}\n`);
  
  // Debug: Pokud PUMP vrací null, zkusíme zjistit proč
  if (pumpCurrentPrice === null) {
    console.log(`   ⚠️  PUMP token returned null. Possible reasons:`);
    console.log(`      - Token not found in Birdeye (mint: ${pumpMint})`);
    console.log(`      - Token has no price data`);
    console.log(`      - Rate limit exceeded`);
    console.log(`      - API error\n`);
  }
  
  // Test 3: Historická cena TRUMP (před 1 dnem)
  console.log('3️⃣ Testing historical price (TRUMP, 1 day ago)...');
  const oneDayAgo = new Date();
  oneDayAgo.setDate(oneDayAgo.getDate() - 1);
  console.log(`   Fetching price for date: ${oneDayAgo.toISOString()} (Unix: ${Math.floor(oneDayAgo.getTime() / 1000)})`);
  const trumpHistorical1Day = await tokenPriceService.getTokenPriceAtDate(trumpMint, oneDayAgo);
  console.log(`   Historical TRUMP price (1 day ago): $${trumpHistorical1Day}\n`);
  
  // Test 4: Historická cena PUMP (před 1 dnem)
  console.log('4️⃣ Testing historical price (PUMP, 1 day ago)...');
  console.log(`   Fetching price for date: ${oneDayAgo.toISOString()} (Unix: ${Math.floor(oneDayAgo.getTime() / 1000)})`);
  const pumpHistorical1Day = await tokenPriceService.getTokenPriceAtDate(pumpMint, oneDayAgo);
  console.log(`   Historical PUMP price (1 day ago): $${pumpHistorical1Day}\n`);
  
  // Test 5: Historická cena TRUMP (před týdnem)
  console.log('5️⃣ Testing historical price (TRUMP, 1 week ago)...');
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  console.log(`   Fetching price for date: ${oneWeekAgo.toISOString()} (Unix: ${Math.floor(oneWeekAgo.getTime() / 1000)})`);
  const trumpHistorical1Week = await tokenPriceService.getTokenPriceAtDate(trumpMint, oneWeekAgo);
  console.log(`   Historical TRUMP price (1 week ago): $${trumpHistorical1Week}\n`);
  
  // Test 6: Historická cena PUMP (před týdnem)
  console.log('6️⃣ Testing historical price (PUMP, 1 week ago)...');
  console.log(`   Fetching price for date: ${oneWeekAgo.toISOString()} (Unix: ${Math.floor(oneWeekAgo.getTime() / 1000)})`);
  const pumpHistorical1Week = await tokenPriceService.getTokenPriceAtDate(pumpMint, oneWeekAgo);
  console.log(`   Historical PUMP price (1 week ago): $${pumpHistorical1Week}\n`);
  
  // Test 7: Historická cena TRUMP (konkrétní datum z předchozích testů - 17.11.2025, 22:36)
  console.log('7️⃣ Testing historical price (TRUMP, specific date: 2025-11-17T22:36:00Z)...');
  const testDate = new Date('2025-11-17T22:36:00Z');
  console.log(`   Testing TRUMP price at ${testDate.toISOString()} (Unix: ${Math.floor(testDate.getTime() / 1000)})...`);
  const trumpHistoricalTest = await tokenPriceService.getTokenPriceAtDate(trumpMint, testDate);
  console.log(`   Historical TRUMP price: $${trumpHistoricalTest}\n`);
  
  console.log('✅ Test completed!');
  console.log('\n📊 Summary:');
  console.log(`   TRUMP - Current: $${trumpCurrentPrice}, 1 day ago: $${trumpHistorical1Day}, 1 week ago: $${trumpHistorical1Week}`);
  console.log(`   PUMP - Current: $${pumpCurrentPrice}, 1 day ago: $${pumpHistorical1Day}, 1 week ago: $${pumpHistorical1Week}`);
}

testBirdeyeHistoricalPrice().catch(console.error);

