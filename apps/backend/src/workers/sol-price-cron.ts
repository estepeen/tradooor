import dotenv from 'dotenv';
import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { BinancePriceService } from '../services/binance-price.service.js';

dotenv.config();

/**
 * Cron job pro aktualizaci SOL ceny z Binance API každých 10 minut
 * 
 * Použití:
 *   pnpm --filter backend sol-price:cron
 * 
 * Nebo s vlastním cron schedule (každých 10 minut):
 *   CRON_SCHEDULE="*/10 * * * *" pnpm --filter backend sol-price:cron
 */
async function updateSolPrice() {
  console.log(`\n⏰ [${new Date().toISOString()}] Updating SOL price from Binance...`);

  const binancePriceService = new BinancePriceService();

  try {
    // Získej aktuální cenu z Binance
    const priceUsd = await binancePriceService.getCurrentSolPrice();
    
    console.log(`   💰 Current SOL price: $${priceUsd.toFixed(2)} USD`);

    // Ulož do databáze
    await prisma.solPriceCache.upsert({
      where: { id: 'current' },
      update: {
        priceUsd,
        updatedAt: new Date(),
        source: 'binance',
      },
      create: {
        id: 'current',
        priceUsd,
        source: 'binance',
      },
    });

    console.log(`   ✅ SOL price updated successfully: $${priceUsd.toFixed(2)} USD`);
  } catch (error: any) {
    console.error('   ❌ Error updating SOL price:', error?.message || error);
    console.error('   Stack:', error?.stack);
  }
}

// Spusť okamžitě při startu
updateSolPrice().catch(console.error);

// Nastav cron schedule (každých 10 minut)
// POZOR: PM2 může mít problém s */10, použijeme '0,10,20,30,40,50 * * * *' nebo '0-59/10 * * * *'
const cronSchedule = process.env.CRON_SCHEDULE || '0,10,20,30,40,50 * * * *'; // Každých 10 minut (0, 10, 20, 30, 40, 50)

console.log(`📅 SOL price cron schedule: ${cronSchedule}`);
console.log('✅ SOL price cron job is running. Press Ctrl+C to stop.');

cron.schedule(cronSchedule, async () => {
  await updateSolPrice();
});

