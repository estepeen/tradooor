/**
 * Position Monitor Worker
 * 
 * Periodicky aktualizuje všechny otevřené pozice:
 * - Aktualizuje aktuální ceny
 * - Kontroluje SL/TP podmínky
 * - Generuje AI doporučení pro exit
 * - Posílá notifikace
 */

import 'dotenv/config';
import { PositionMonitorService } from '../services/position-monitor.service.js';

const positionMonitor = new PositionMonitorService();

// Config
const UPDATE_INTERVAL_MS = Number(process.env.POSITION_UPDATE_INTERVAL_MS || 5 * 60 * 1000); // 5 minutes default
const INITIAL_DELAY_MS = 30000; // 30 seconds initial delay

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
  console.log(`   Update interval: ${UPDATE_INTERVAL_MS / 1000}s`);
  console.log(`   Initial delay: ${INITIAL_DELAY_MS / 1000}s`);
  
  // Wait initial delay to let other services start
  await new Promise(resolve => setTimeout(resolve, INITIAL_DELAY_MS));
  
  // Run first update
  await runPositionUpdate();
  
  // Schedule periodic updates
  setInterval(runPositionUpdate, UPDATE_INTERVAL_MS);
  
  console.log('✅ Position Monitor Worker running. Press Ctrl+C to stop.');
}

main().catch(error => {
  console.error('Fatal error in Position Monitor Worker:', error);
  process.exit(1);
});

