#!/bin/bash

# Script to delete all trades data from PostgreSQL database
# WARNING: This will permanently delete all trade data!
# IMPORTANT: SIGNALS are PRESERVED - Signal and ConsensusSignal tables are NOT deleted!

set -e

# Load DATABASE_URL from .env file
if [ -f .env ]; then
  export $(grep -v '^#' .env | grep DATABASE_URL | xargs)
fi

if [ -z "$DATABASE_URL" ]; then
  echo "❌ Error: DATABASE_URL not found in environment or .env file"
  exit 1
fi

echo "⚠️  WARNING: This will delete ALL trades and related data from the database!"
echo "Starting deletion..."
echo ""

# Delete in order respecting foreign key constraints
echo "🗑️  Deleting closed lots..."
psql "$DATABASE_URL" -c 'DELETE FROM "ClosedLot";' -t -A | xargs -I {} echo "   Deleted {} closed lots"

echo "🗑️  Deleting trade features..."
psql "$DATABASE_URL" -c 'DELETE FROM "TradeFeature";' -t -A | xargs -I {} echo "   Deleted {} trade features"

echo "🗑️  Deleting normalized trades..."
psql "$DATABASE_URL" -c 'DELETE FROM "NormalizedTrade";' -t -A | xargs -I {} echo "   Deleted {} normalized trades"

echo "🗑️  Deleting paper trades..."
psql "$DATABASE_URL" -c 'DELETE FROM "PaperTrade";' -t -A | xargs -I {} echo "   Deleted {} paper trades"

echo "🗑️  Deleting trades..."
psql "$DATABASE_URL" -c 'DELETE FROM "Trade";' -t -A | xargs -I {} echo "   Deleted {} trades"

echo "🗑️  Deleting trade sequences..."
psql "$DATABASE_URL" -c 'DELETE FROM "TradeSequence";' -t -A | xargs -I {} echo "   Deleted {} trade sequences"

echo "🗑️  Deleting trade outcomes..."
psql "$DATABASE_URL" -c 'DELETE FROM "TradeOutcome";' -t -A | xargs -I {} echo "   Deleted {} trade outcomes"

echo "🗑️  Deleting metrics history..."
psql "$DATABASE_URL" -c 'DELETE FROM "SmartWalletMetricsHistory";' -t -A | xargs -I {} echo "   Deleted {} metrics history records"

echo "🗑️  Clearing wallet processing queue..."
psql "$DATABASE_URL" -c 'DELETE FROM "WalletProcessingQueue";' -t -A | xargs -I {} echo "   Deleted {} queue records"

echo "🔄 Resetting wallet metrics..."
psql "$DATABASE_URL" -c 'UPDATE "SmartWallet" SET
  score = 0,
  "totalTrades" = 0,
  "winRate" = 0,
  "avgRr" = 0,
  "avgPnlPercent" = 0,
  "pnlTotalBase" = 0,
  "avgHoldingTimeMin" = 0,
  "maxDrawdownPercent" = 0,
  "recentPnl30dPercent" = 0,
  "recentPnl30dUsd" = 0,
  "advancedStats" = NULL,
  tags = '\''{}'\'',
  "updatedAt" = NOW();' -t -A | xargs -I {} echo "   Reset metrics for {} wallets"

echo ""
echo "✅ All trades and related data deleted!"
echo "   - All trades deleted"
echo "   - All closed lots deleted"
echo "   - All trade features deleted"
echo "   - All normalized trades deleted"
echo "   - All paper trades deleted"
echo "   - All trade sequences deleted"
echo "   - All trade outcomes deleted"
echo "   - Wallet processing queue cleared"
echo "   - Metrics history deleted"
echo "   - Wallet metrics reset (score, PnL, advancedStats, tags)"
echo ""
echo "✅ SIGNALS PRESERVED - Signal and ConsensusSignal tables were NOT deleted!"

