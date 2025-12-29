#!/bin/bash

# Deployment script for 7d/30d hybrid scoring system update
# Usage: ./deploy-scoring-update.sh

set -e  # Exit on error

PROJECT_DIR="/opt/tradooor"

echo "🚀 Deploying 7d/30d Hybrid Scoring System Update..."
echo "   Directory: ${PROJECT_DIR}"
echo ""

# Navigate to project directory
cd "${PROJECT_DIR}" || {
  echo "❌ Error: Project directory not found: ${PROJECT_DIR}"
  echo "   Make sure you're running this on the VPS"
  exit 1
}

# 1. Git pull
echo "📥 Pulling latest changes from git..."
git fetch origin
git pull origin master
echo "✅ Git pull completed"
echo ""

# 2. Run database migration
echo "🗄️  Running database migration (add score7d, score30d columns)..."
psql -U postgres -d tradooor_db -f migrations/add_score_7d_30d_columns.sql
echo "✅ Database migration completed"
echo ""

# 3. Generate Prisma client
echo "🔧 Generating Prisma client..."
cd packages/db
npx prisma generate
cd "${PROJECT_DIR}"
echo "✅ Prisma client generated"
echo ""

# 4. Install dependencies (if needed)
echo "📦 Installing dependencies..."
pnpm install --frozen-lockfile
echo "✅ Dependencies installed"
echo ""

# 5. Build backend
echo "🔨 Building backend..."
pnpm --filter backend build
echo "✅ Backend built"
echo ""

# 6. Restart PM2 processes
echo "🔄 Restarting PM2 processes..."
pm2 restart tradooor-backend || echo "⚠️  Backend not running, starting..."
pm2 restart tradooor-metrics-cron || echo "⚠️  Metrics cron not running, starting..."
pm2 save
echo "✅ PM2 processes restarted"
echo ""

# 7. Wait for services to start
echo "⏳ Waiting 5 seconds for services to start..."
sleep 5
echo ""

# 8. Verify migration
echo "🔍 Verifying database migration..."
psql -U postgres -d tradooor_db -c "\d \"SmartWallet\"" | grep -E "score7d|score30d|recentPnl7d" || echo "⚠️  Could not verify columns"
echo ""

# 9. Show PM2 status
echo "📊 PM2 Status:"
pm2 status
echo ""

# 10. Show recent logs
echo "📋 Recent backend logs (last 20 lines):"
pm2 logs tradooor-backend --lines 20 --nostream || true
echo ""

# 11. Trigger score recalculation
echo "📊 Triggering score recalculation for all wallets..."
echo "   This will run in the background via metrics-cron"
echo "   Monitor with: pm2 logs tradooor-metrics-cron"
echo ""

echo "✅ Deployment completed successfully!"
echo ""
echo "📋 What changed:"
echo "   • Added score7d and score30d columns to database"
echo "   • Implemented 7d/30d hybrid scoring (70%/30% weight)"
echo "   • Added sample confidence penalty for low-trade wallets"
echo "   • Added position size factor (±5 points)"
echo "   • Lowered signal tier thresholds (40-55 instead of 65-75)"
echo "   • Added Score 7d and Score 30d columns to web UI"
echo ""
echo "💡 Next steps:"
echo "   1. Visit https://tradooor.stepanpanek.cz to verify web UI"
echo "   2. Check that Score 7d and Score 30d columns appear in trader table"
echo "   3. Monitor logs: pm2 logs tradooor-backend"
echo "   4. Wait for next metrics-cron run to see updated scores"
echo "   5. Monitor Discord for signals from traders who now meet thresholds"
echo ""
echo "🔧 Manual score recalculation (if needed):"
echo "   pnpm --filter backend metrics:cron"
echo ""
