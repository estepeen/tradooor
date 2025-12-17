import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

// Load environment variables from .env
dotenv.config();

// Create Prisma client instance
const prismaClient = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
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

