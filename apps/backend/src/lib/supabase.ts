import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

// MIGRATION NOTE: We're transitioning from Supabase to Prisma
// If SUPABASE_URL is not set, use Prisma instead
// This is a temporary bridge during migration
let supabase: any;

if (supabaseUrl && supabaseKey) {
  // Use Supabase if credentials are available
  supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  console.log('✅ Using Supabase SDK for database operations');
} else if (process.env.DATABASE_URL) {
  // Use Prisma if DATABASE_URL is available
  console.log('⚠️  SUPABASE_URL not found, will use Prisma instead');
  console.log('⚠️  Note: Some services still need to be migrated to Prisma');
  // Import Prisma client
  import('./prisma.js').then((module) => {
    supabase = module.prisma;
  });
} else {
  throw new Error(
    'Missing database configuration. Please set either SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY or DATABASE_URL in your .env file.'
  );
}

export { supabase };

// Database table names (matching Prisma schema)
export const TABLES = {
  SMART_WALLET: 'SmartWallet',
  TRADE: 'Trade',
  NORMALIZED_TRADE: 'NormalizedTrade',
  TOKEN: 'Token',
  TOKEN_MARKET_SNAPSHOT: 'TokenMarketSnapshot',
  SMART_WALLET_METRICS_HISTORY: 'SmartWalletMetricsHistory',
  CLOSED_LOT: 'ClosedLot',
  WALLET_PROCESSING_QUEUE: 'WalletProcessingQueue',
  TRADE_FEATURE: 'TradeFeature',
  TRADE_SEQUENCE: 'TradeSequence',
  TRADE_OUTCOME: 'TradeOutcome',
  TRADER_CORRELATION: 'TraderCorrelation',
  TRADER_BEHAVIOR_PROFILE: 'TraderBehaviorProfile',
  PAPER_TRADE: 'PaperTrade',
  PAPER_PORTFOLIO: 'PaperPortfolio',
  SIGNAL: 'Signal',
  CONSENSUS_SIGNAL: 'ConsensusSignal',
} as const;

/**
 * Generate a CUID-like ID
 * Simple implementation - for production, consider using @paralleldrive/cuid2
 */
export function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 15);
  return `c${timestamp}${random}`;
}

