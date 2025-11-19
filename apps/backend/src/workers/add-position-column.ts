/**
 * Worker script pro přidání sloupce positionChangePercent do databáze
 * Použije PostgreSQL connection string z .env
 * 
 * Použití:
 *   pnpm --filter backend position:add-column
 */

import dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config();

async function main() {
  console.log('🔄 Adding positionChangePercent column to Trade table...\n');

  const databaseUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL or SUPABASE_DB_URL not found in .env');
    console.log('\n💡 Add DATABASE_URL to your .env file:');
    console.log('   DATABASE_URL="postgresql://postgres:[PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres"');
    console.log('\n   Or run this SQL manually in Supabase SQL Editor:');
    console.log('\n' + '='.repeat(70));
    console.log('ALTER TABLE "Trade"');
    console.log('ADD COLUMN IF NOT EXISTS "positionChangePercent" DECIMAL(36, 18);');
    console.log('='.repeat(70) + '\n');
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
  });

  try {
    await client.connect();
    console.log('✅ Connected to database');

    // Spusť SQL migraci
    const sql = `
      ALTER TABLE "Trade" 
      ADD COLUMN IF NOT EXISTS "positionChangePercent" DECIMAL(36, 18);

      COMMENT ON COLUMN "Trade"."positionChangePercent" IS 'Percentage change in position size for this trade. Positive = buy (increased position), Negative = sell (decreased position)';
    `;

    await client.query(sql);
    console.log('✅ Column positionChangePercent added successfully!');
    console.log('\n📝 Next step: Run position:recalculate to calculate values for existing trades\n');

  } catch (error: any) {
    console.error('❌ Error:', error.message);
    
    if (error.message.includes('column') && error.message.includes('already exists')) {
      console.log('✅ Column already exists!');
      console.log('\n📝 You can run position:recalculate to calculate values\n');
    } else {
      console.log('\n📋 Please run this SQL manually in Supabase SQL Editor:');
      console.log('\n' + '='.repeat(70));
      console.log('ALTER TABLE "Trade"');
      console.log('ADD COLUMN IF NOT EXISTS "positionChangePercent" DECIMAL(36, 18);');
      console.log('='.repeat(70) + '\n');
    }
    
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();

