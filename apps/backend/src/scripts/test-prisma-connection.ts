/**
 * Test Prisma connection to local PostgreSQL database
 */

import { prisma } from '../lib/prisma.js';

async function testConnection() {
  try {
    console.log('🔄 Testing Prisma connection to local PostgreSQL...');
    
    // Test 1: Basic connection
    await prisma.$connect();
    console.log('✅ Successfully connected to database');
    
    // Test 2: Count records
    const [walletCount, tradeCount, tokenCount] = await Promise.all([
      prisma.smartWallet.count(),
      prisma.trade.count(),
      prisma.token.count(),
    ]);
    
    console.log('\n📊 Database statistics:');
    console.log(`   SmartWallets: ${walletCount}`);
    console.log(`   Trades: ${tradeCount}`);
    console.log(`   Tokens: ${tokenCount}`);
    
    // Test 3: Fetch a sample wallet
    const sampleWallet = await prisma.smartWallet.findFirst({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        address: true,
        label: true,
        score: true,
        totalTrades: true,
      },
    });
    
    if (sampleWallet) {
      console.log('\n📝 Sample wallet:');
      console.log(`   ID: ${sampleWallet.id}`);
      console.log(`   Address: ${sampleWallet.address.substring(0, 8)}...`);
      console.log(`   Label: ${sampleWallet.label || 'N/A'}`);
      console.log(`   Score: ${sampleWallet.score}`);
      console.log(`   Total Trades: ${sampleWallet.totalTrades}`);
    }
    
    // Test 4: Fetch a sample token
    const sampleToken = await prisma.token.findFirst({
      orderBy: { firstSeenAt: 'desc' },
      select: {
        id: true,
        mintAddress: true,
        symbol: true,
        name: true,
      },
    });
    
    if (sampleToken) {
      console.log('\n🪙 Sample token:');
      console.log(`   ID: ${sampleToken.id}`);
      console.log(`   Mint: ${sampleToken.mintAddress.substring(0, 8)}...`);
      console.log(`   Symbol: ${sampleToken.symbol || 'N/A'}`);
      console.log(`   Name: ${sampleToken.name || 'N/A'}`);
    }
    
    console.log('\n✅ All tests passed! Prisma is working correctly.');
    
  } catch (error: any) {
    console.error('\n❌ Error testing Prisma connection:');
    console.error(`   Message: ${error.message}`);
    if (error.code) {
      console.error(`   Code: ${error.code}`);
    }
    if (error.meta) {
      console.error(`   Meta: ${JSON.stringify(error.meta, null, 2)}`);
    }
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

testConnection();

