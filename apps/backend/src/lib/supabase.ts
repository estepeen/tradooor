import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Missing Supabase environment variables. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) in your .env file.'
  );
}

// Use service role key for backend operations (bypasses RLS)
// For frontend, use anon key with proper RLS policies
export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// Database table names (matching Prisma schema)
export const TABLES = {
  SMART_WALLET: 'SmartWallet',
  TRADE: 'Trade',
  NORMALIZED_TRADE: 'NormalizedTrade',
  TOKEN: 'Token',
  TOKEN_MARKET_SNAPSHOT: 'TokenMarketSnapshot',
  SMART_WALLET_METRICS_HISTORY: 'SmartWalletMetricsHistory',
  CLOSED_LOT: 'ClosedLot',
  OPEN_POSITION: 'OpenPosition',
  WALLET_PROCESSING_QUEUE: 'WalletProcessingQueue',
  TRADE_FEATURE: 'TradeFeature',
  TRADE_SEQUENCE: 'TradeSequence',
  TRADE_OUTCOME: 'TradeOutcome',
  TRADER_CORRELATION: 'TraderCorrelation',
  TRADER_BEHAVIOR_PROFILE: 'TraderBehaviorProfile',
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

