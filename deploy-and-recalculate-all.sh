#!/bin/bash

# Deploy and recalculate ALL closed lots with fixed FIFO proceeds calculation
# Usage: ./deploy-and-recalculate-all.sh

set -e  # Exit on error

PROJECT_DIR="/opt/tradooor"
BRANCH="${1:-master}"

echo "🚀 Starting deployment and recalculation for ALL wallets..."
echo "   Branch: ${BRANCH}"
echo "   Directory: ${PROJECT_DIR}"
echo ""

# Navigate to project directory
cd "${PROJECT_DIR}" || {
  echo "❌ Error: Project directory not found: ${PROJECT_DIR}"
  exit 1
}

# 1. Git pull
echo "📥 Pulling latest changes from git..."
git fetch origin
git checkout "${BRANCH}"
git pull origin "${BRANCH}"
echo "✅ Git pull completed"
echo ""

# 2. Install dependencies (if needed)
echo "📦 Installing dependencies..."
pnpm install --frozen-lockfile
echo "✅ Dependencies installed"
echo ""

# 3. Build backend
echo "🔨 Building backend..."
cd "${PROJECT_DIR}"
pnpm --filter backend build
echo "✅ Backend built"
echo ""

# 4. Restart PM2 processes
echo "🔄 Restarting PM2 processes..."
pm2 restart tradooor-backend || echo "⚠️  Backend not running, starting..."
pm2 restart tradooor-normalized-trade-processor || echo "⚠️  Trade processor not running, starting..."
pm2 restart tradooor-metrics-cron || echo "⚠️  Metrics cron not running, starting..."
pm2 save
echo "✅ PM2 processes restarted"
echo ""

# 5. Wait a bit for services to start
echo "⏳ Waiting 5 seconds for services to start..."
sleep 5
echo ""

# 6. Recalculate closed lots for ALL wallets
echo "📊 Recalculating closed lots and metrics for ALL wallets..."
echo "   This may take a while depending on the number of wallets..."
cd "${PROJECT_DIR}"
pnpm --filter backend metrics:cron
echo ""

# 7. Show PM2 status
echo "📊 PM2 Status:"
pm2 status
echo ""

# 8. Show recent logs
echo "📋 Recent logs (last 20 lines):"
pm2 logs tradooor-backend --lines 20 --nostream || true
echo ""

echo "✅ Deployment and recalculation completed!"
echo ""
echo "💡 Next steps:"
echo "   1. Check wallet PnL in the frontend"
echo "   2. Monitor logs: pm2 logs tradooor-backend"
echo "   3. Verify PnL values are correct (should use sellAmountTotal, not totalConsumedFromOpenLots)"
echo ""
echo "🔍 To check a specific wallet:"
echo "   pnpm --filter backend recalculate:wallet-closed-positions WALLET_ADDRESS"

