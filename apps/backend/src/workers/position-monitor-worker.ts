/**
 * Position Monitor Worker
 * 
 * Dynamicky kontroluje pozice na základě market capu:
 * - < 300k: každou 1 minutu (shitcoiny - rychlé změny)
 * - 300k-500k: každé 2 minuty
 * - 500k-1M: každé 2 minuty
 * - > 1M: každých 5 minut (stabilnější tokeny)
 * 
 * Worker běží každou minutu, ale pozice se aktualizují jen když uplyne jejich interval
 */

import 'dotenv/config';
import { PositionMonitorService } from '../services/position-monitor.service.js';

const positionMonitor = new PositionMonitorService();

// Kontroluj každou minutu (nejrychlejší interval pro malé tokeny)
const UPDATE_INTERVAL_MS = 1 * 60 * 1000; // 1 minuta
const INITIAL_DELAY_MS = 10000; // 10 seconds initial delay

async function runPositionUpdate() {
  try {
    console.log('\n📊 [PositionMonitor] Starting position update cycle...');
    const startTime = Date.now();
    
    await positionMonitor.updateAllOpenPositions();
    
    const duration = Date.now() - startTime;
    console.log(`✅ [PositionMonitor] Update cycle completed in ${(duration / 1000).toFixed(1)}s\n`);
  } catch (error: any) {
    console.error(`❌ [PositionMonitor] Error in update cycle: ${error.message}`);
  }
}

async function main() {
  console.log('🚀 Position Monitor Worker starting...');
  console.log('   Dynamic intervals based on market cap:');
  console.log('   - < 300k: 1 minute (shitcoins)');
  console.log('   - 300k-500k: 2 minutes');
  console.log('   - 500k-1M: 2 minutes');
  console.log('   - > 1M: 5 minutes');
  console.log(`   Check cycle: every ${UPDATE_INTERVAL_MS / 1000}s (1 min)`);
  console.log(`   Initial delay: ${INITIAL_DELAY_MS / 1000}s`);
  
  // Wait initial delay to let other services start
  await new Promise(resolve => setTimeout(resolve, INITIAL_DELAY_MS));
  
  // Run first update
  await runPositionUpdate();
  
  // Schedule updates every minute
  setInterval(runPositionUpdate, UPDATE_INTERVAL_MS);
  
  console.log('✅ Position Monitor Worker running. Press Ctrl+C to stop.');
}

main().catch(error => {
  console.error('Fatal error in Position Monitor Worker:', error);
  process.exit(1);
});

