#!/bin/bash

# Restart services and debug PnL display
# Usage: ./restart-and-debug.sh [WALLET_ADDRESS]

set -e  # Exit on error

WALLET_ADDRESS="${1:-2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f}"
PROJECT_DIR="/opt/tradooor"

echo "🔄 Restarting services and debugging PnL..."
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

# 4. Restart PM2 processes
echo "🔄 Restarting PM2 processes..."
pm2 restart tradooor-backend || pm2 start ecosystem.config.js --only tradooor-backend
pm2 restart tradooor-normalized-trade-processor || pm2 start ecosystem.config.js --only tradooor-normalized-trade-processor
pm2 restart tradooor-metrics-cron || pm2 start ecosystem.config.js --only tradooor-metrics-cron
pm2 save
echo "✅ PM2 processes restarted"
echo ""

# 5. Wait for services to start
echo "⏳ Waiting 10 seconds for services to start..."
sleep 10
echo ""

# 6. Debug PnL display
echo "🔍 Debugging PnL display for wallet ${WALLET_ADDRESS}..."
pnpm --filter backend debug:pnl-display "${WALLET_ADDRESS}"
echo ""

# 7. Show PM2 status
echo "📊 PM2 Status:"
pm2 status
echo ""

# 8. Show recent logs
echo "📋 Recent backend logs (last 30 lines):"
pm2 logs tradooor-backend --lines 30 --nostream || true
echo ""

echo "✅ Restart and debug completed!"
echo ""
echo "💡 Next steps:"
echo "   1. Check wallet PnL in the frontend"
echo "   2. Monitor logs: pm2 logs tradooor-backend --lines 50"
echo "   3. If PnL is still wrong, check database values:"
echo "      pnpm --filter backend debug:pnl-display ${WALLET_ADDRESS}"

