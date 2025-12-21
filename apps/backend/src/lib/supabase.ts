// Supabase has been removed - we use Prisma only
// This file is kept for backward compatibility (TABLES export)
// All database operations should use Prisma directly

// Export null supabase to prevent errors in legacy code
export const supabase: any = null;

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

