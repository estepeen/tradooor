import 'dotenv/config';
import { execSync } from 'child_process';

/**
 * Master script for full recalculation:
 * 1. Backfill all wallets from RPC (find missing transactions)
 * 2. Reprocess all VOID trades with new logic
 * 3. Recalculate all open/closed positions
 * 4. Recalculate all metrics (which will sync PnL)
 * 
 * Usage:
 *   pnpm full-recalculation [hoursBack]
 * 
 * Example:
 *   pnpm full-recalculation 24  # Last 24 hours
 */

async function fullRecalculation(hoursBack: number = 24) {
  console.log(`\n🚀 Starting FULL RECALCULATION process...\n`);
  console.log(`   Time range: last ${hoursBack} hours\n`);

  try {
    // Step 1: Backfill all wallets from RPC
    console.log(`\n📥 STEP 1: Backfilling all wallets from RPC...\n`);
    console.log(`   This will find and add missing transactions with correct SOL calculations\n`);
    execSync(`pnpm --filter backend backfill-all-wallets ${hoursBack}`, {
      stdio: 'inherit',
      cwd: process.cwd(),
    });

    // Step 2: Reprocess all VOID trades
    console.log(`\n🔄 STEP 2: Reprocessing all VOID trades...\n`);
    console.log(`   This will reprocess VOID trades with new WSOL detection logic\n`);
    execSync(`pnpm --filter backend reprocess-all-void-trades`, {
      stdio: 'inherit',
      cwd: process.cwd(),
    });

    // Step 3: Recalculate all positions (closed lots)
    console.log(`\n📊 STEP 3: Recalculating all open/closed positions...\n`);
    console.log(`   This will recreate all closed lots with updated trade values\n`);
    execSync(`pnpm --filter backend recalculate-all-positions`, {
      stdio: 'inherit',
      cwd: process.cwd(),
    });

    // Step 4: Recalculate all metrics (to sync PnL)
    console.log(`\n💰 STEP 4: Recalculating all metrics...\n`);
    console.log(`   This will sync PnL across homepage, detail page, and stats page\n`);
    execSync(`pnpm --filter backend calculate:metrics`, {
      stdio: 'inherit',
      cwd: process.cwd(),
    });

    console.log(`\n✅ FULL RECALCULATION COMPLETE!\n`);
    console.log(`   All wallets have been:`);
    console.log(`   ✓ Backfilled from RPC`);
    console.log(`   ✓ VOID trades reprocessed`);
    console.log(`   ✓ Positions recalculated`);
    console.log(`   ✓ Metrics recalculated (PnL synchronized)\n`);
  } catch (error: any) {
    console.error(`\n❌ Error during full recalculation: ${error.message}\n`);
    process.exit(1);
  }
}

// Run script
const hoursBack = parseInt(process.argv[2]) || 24;

fullRecalculation(hoursBack).catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

