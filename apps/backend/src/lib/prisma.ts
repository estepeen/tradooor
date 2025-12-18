import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

// Load environment variables from .env
dotenv.config();

/**
 * Enhance DATABASE_URL with connection pool parameters if not present
 * Prisma reads connection_limit and connection_timeout from DATABASE_URL query params
 * Default: connection_limit=5, timeout=10s (too low for production with multiple workers)
 */
function enhanceDatabaseUrl(url: string | undefined): string {
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }

  // If URL already has query params, check if connection_limit is set
  const urlObj = new URL(url);
  const hasConnectionLimit = urlObj.searchParams.has('connection_limit');
  const hasPoolTimeout = urlObj.searchParams.has('pool_timeout');

  // Add connection pool parameters if not present
  // IMPORTANT: Keep connection_limit LOW because we have multiple PM2 processes
  // Each process gets its own pool, so: 5 processes × 10 connections = 50 total
  // PostgreSQL default max_connections is usually 100
  if (!hasConnectionLimit) {
    urlObj.searchParams.set('connection_limit', '10'); // Low per-process limit (multiple workers share DB)
  }
  if (!hasPoolTimeout) {
    urlObj.searchParams.set('pool_timeout', '30'); // Reasonable timeout
  }

  return urlObj.toString();
}

// Get enhanced DATABASE_URL with connection pool parameters
const databaseUrl = enhanceDatabaseUrl(process.env.DATABASE_URL);

// Create Prisma client instance with increased connection pool
// Connection pool is configured via DATABASE_URL query parameters
const prismaClient = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  datasources: {
    db: {
      url: databaseUrl,
    },
  },
});

// Export as both default and named for flexibility
export const prisma = prismaClient;
export default prismaClient;

// Handle graceful shutdown
process.on('beforeExit', async () => {
  await prismaClient.$disconnect();
});

// Database table names (for compatibility with existing code)
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
  AI_DECISION: 'AIDecision',
  VIRTUAL_POSITION: 'VirtualPosition',
  POSITION_WALLET_ACTIVITY: 'PositionWalletActivity',
  EXIT_SIGNAL: 'ExitSignal',
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

/**
 * CRITICAL: Safely convert Prisma Decimal to JavaScript number
 * 
 * Prisma returns Decimal objects for columns with @db.Decimal(36, 18).
 * Using Number(prismaDecimal) DOES NOT WORK correctly!
 * You MUST use value.toNumber() for Prisma Decimal objects.
 * 
 * @param value - Value to convert (can be Prisma Decimal, string, number, or null)
 * @param defaultValue - Default value to return if conversion fails (default: 0)
 * @returns JavaScript number
 */
export function safeDecimalToNumber(value: any, defaultValue: number = 0): number {
  if (value === null || value === undefined) return defaultValue;
  
  // Check if it's a Prisma Decimal object (has toNumber method)
  if (typeof value === 'object' && typeof value.toNumber === 'function') {
    try {
      return value.toNumber();
    } catch {
      return defaultValue;
    }
  }
  
  // Check if it's a string (from raw SQL or JSON)
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') return defaultValue;
    const parsed = parseFloat(trimmed);
    return isNaN(parsed) || !isFinite(parsed) ? defaultValue : parsed;
  }
  
  // Fallback to Number() for plain numbers
  const num = Number(value);
  return isNaN(num) || !isFinite(num) ? defaultValue : num;
}

