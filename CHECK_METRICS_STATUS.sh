#!/bin/bash

echo "🔍 Checking metrics worker and database status..."
echo ""

# 1. Check PM2 processes
echo "1. PM2 Processes:"
echo "─────────────────────────────────────────"
pm2 list | grep -E "tradooor-metrics|tradooor-backend"
echo ""

# 2. Check if metrics worker is running
echo "2. Metrics Worker Status:"
echo "─────────────────────────────────────────"
if pm2 list | grep -q "tradooor-metrics-worker.*online"; then
    echo "✅ tradooor-metrics-worker is running"
    pm2 logs tradooor-metrics-worker --lines 5 --nostream
else
    echo "❌ tradooor-metrics-worker is NOT running"
fi
echo ""

# 3. Check if metrics cron is running
echo "3. Metrics Cron Status:"
echo "─────────────────────────────────────────"
if pm2 list | grep -q "tradooor-metrics-cron.*online"; then
    echo "✅ tradooor-metrics-cron is running"
else
    echo "❌ tradooor-metrics-cron is NOT running (this is OK if it runs on schedule)"
fi
echo ""

# 4. Check recent backend logs for errors
echo "4. Recent Backend Logs (errors):"
echo "─────────────────────────────────────────"
pm2 logs tradooor-backend --lines 10 --nostream 2>&1 | grep -iE "error|fail|metrics" | tail -5 || echo "No errors found"
echo ""

# 5. Check if there are any trades in database (via backend API)
echo "5. Database Status (via API):"
echo "─────────────────────────────────────────"
curl -s "http://localhost:3001/api/stats/overview" | jq -r '.totalWallets, .totalTrades' 2>/dev/null || echo "❌ Cannot connect to backend API"
echo ""

echo "✅ Diagnostic complete!"
echo ""
echo "💡 If metrics worker is not running, start it with:"
echo "   pm2 start \"pnpm --filter @solbot/backend metrics:worker\" --name tradooor-metrics-worker"
echo ""
echo "💡 If metrics cron is not running, start it with:"
echo "   pm2 start \"pnpm --filter @solbot/backend metrics:cron\" --name tradooor-metrics-cron"
echo ""
echo "💡 To manually recalculate metrics for all wallets:"
echo "   cd /opt/tradooor && pnpm --filter @solbot/backend metrics:cron"
