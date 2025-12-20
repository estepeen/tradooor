#!/bin/bash

# Full restart with frontend rebuild and debug
# Usage: ./full-restart-debug.sh [WALLET_ADDRESS]

set -e  # Exit on error

WALLET_ADDRESS="${1:-2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f}"
PROJECT_DIR="/opt/tradooor"

echo "🔄 Full restart with frontend rebuild and debug..."
echo "   Wallet: ${WALLET_ADDRESS}"
echo "   Directory: ${PROJECT_DIR}"
echo ""

# Navigate to project directory
cd "${PROJECT_DIR}" || {
  echo "❌ Error: Project directory not found: ${PROJECT_DIR}"
  exit 1
}

# 1. Git pull
echo "📥 Pulling latest changes..."
git fetch origin
git pull origin master
echo "✅ Git pull completed"
echo ""

# 2. Install dependencies
echo "📦 Installing dependencies..."
pnpm install --frozen-lockfile
echo "✅ Dependencies installed"
echo ""

# 3. Build backend
echo "🔨 Building backend..."
pnpm --filter backend build
echo "✅ Backend built"
echo ""

# 4. Build frontend
echo "🔨 Building frontend..."
pnpm --filter frontend build
echo "✅ Frontend built"
echo ""

# 5. Restart PM2 processes
echo "🔄 Restarting PM2 processes..."
pm2 restart tradooor-backend || pm2 start ecosystem.config.js --only tradooor-backend
pm2 restart tradooor-normalized-trade-processor || pm2 start ecosystem.config.js --only tradooor-normalized-trade-processor
pm2 restart tradooor-metrics-cron || pm2 start ecosystem.config.js --only tradooor-metrics-cron
pm2 restart tradooor-frontend || pm2 start ecosystem.config.js --only tradooor-frontend
pm2 save
echo "✅ PM2 processes restarted"
echo ""

# 6. Wait for services to start
echo "⏳ Waiting 15 seconds for services to start..."
sleep 15
echo ""

# 7. Recalculate wallet metrics (to fix database PnL)
echo "📊 Recalculating wallet metrics for ${WALLET_ADDRESS}..."
pnpm --filter backend recalculate:wallet-closed-positions "${WALLET_ADDRESS}"
echo ""

# 8. Debug PnL display
echo "🔍 Debugging PnL display for wallet ${WALLET_ADDRESS}..."
pnpm --filter backend debug:pnl-display "${WALLET_ADDRESS}"
echo ""

# 9. Show PM2 status
echo "📊 PM2 Status:"
pm2 status
echo ""

# 10. Show recent logs
echo "📋 Recent backend logs (last 50 lines):"
pm2 logs tradooor-backend --lines 50 --nostream || true
echo ""

echo "✅ Full restart and debug completed!"
echo ""
echo "💡 Next steps:"
echo "   1. Clear browser cache (Ctrl+Shift+R or Cmd+Shift+R)"
echo "   2. Check wallet PnL in the frontend"
echo "   3. Open browser console (F12) and check for debug logs"
echo "   4. Monitor logs: pm2 logs tradooor-backend --lines 50"
echo "   5. If PnL is still wrong, check database values:"
echo "      pnpm --filter backend debug:pnl-display ${WALLET_ADDRESS}"

