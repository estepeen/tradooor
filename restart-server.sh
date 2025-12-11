#!/bin/bash

# Script pro restart serveru po deploy
# Zabije procesy na portech 3000 a 3001, spustí migraci a restartuje služby

set -e

echo "🔄 Restarting server..."

# 1. Zabij procesy na portech 3000 a 3001
echo "🔪 Killing processes on ports 3000 and 3001..."
lsof -ti:3000 | xargs kill -9 2>/dev/null || echo "   No process on port 3000"
lsof -ti:3001 | xargs kill -9 2>/dev/null || echo "   No process on port 3001"
sleep 2

# 2. Spusť migraci databáze
echo "📦 Running database migration..."
cd /opt/tradooor
pnpm --filter @solbot/db db:migrate || echo "   ⚠️  Migration failed or already up to date"

# 3. Build backend a frontend
echo "🔨 Building backend and frontend..."
pnpm --filter backend build
pnpm --filter frontend build

# 4. Spusť backend (v pozadí)
echo "🚀 Starting backend..."
cd /opt/tradooor
pnpm --filter backend start > /tmp/backend.log 2>&1 &
BACKEND_PID=$!
echo "   Backend PID: $BACKEND_PID"

# 5. Spusť frontend (v pozadí)
echo "🚀 Starting frontend..."
cd /opt/tradooor
pnpm --filter frontend start > /tmp/frontend.log 2>&1 &
FRONTEND_PID=$!
echo "   Frontend PID: $FRONTEND_PID"

# 6. Spusť backfill cron (v pozadí)
echo "🚀 Starting backfill cron..."
cd /opt/tradooor
pnpm --filter backend backfill:cron > /tmp/backfill-cron.log 2>&1 &
BACKFILL_PID=$!
echo "   Backfill cron PID: $BACKFILL_PID"

echo ""
echo "✅ Server restarted!"
echo "   Backend: http://localhost:3001 (PID: $BACKEND_PID)"
echo "   Frontend: http://localhost:3000 (PID: $FRONTEND_PID)"
echo "   Backfill cron: running (PID: $BACKFILL_PID)"
echo ""
echo "📋 Logs:"
echo "   Backend: tail -f /tmp/backend.log"
echo "   Frontend: tail -f /tmp/frontend.log"
echo "   Backfill cron: tail -f /tmp/backfill-cron.log"
echo ""
echo "💡 To stop all processes:"
echo "   kill $BACKEND_PID $FRONTEND_PID $BACKFILL_PID"

