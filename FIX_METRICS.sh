#!/bin/bash

echo "🔧 Fixing metrics calculation..."
echo ""

# 1. Check if metrics worker is running
echo "1. Checking metrics worker status..."
if pm2 list | grep -q "tradooor-metrics-worker.*online"; then
    echo "✅ tradooor-metrics-worker is running"
else
    echo "❌ tradooor-metrics-worker is NOT running"
    echo "   Starting metrics worker..."
    cd /opt/tradooor
    pm2 start "pnpm --filter @solbot/backend metrics:worker" --name tradooor-metrics-worker
    pm2 save
fi
echo ""

# 2. Check if metrics cron is running
echo "2. Checking metrics cron status..."
if pm2 list | grep -q "tradooor-metrics-cron.*online"; then
    echo "✅ tradooor-metrics-cron is running"
else
    echo "⚠️  tradooor-metrics-cron is NOT running"
    echo "   Starting metrics cron (will recalculate metrics immediately)..."
    cd /opt/tradooor
    pm2 start "pnpm --filter @solbot/backend metrics:cron" --name tradooor-metrics-cron
    pm2 save
fi
echo ""

# 3. Manually trigger metrics recalculation
echo "3. Manually triggering metrics recalculation..."
echo "   (This will recalculate metrics for all wallets)"
cd /opt/tradooor
pnpm --filter @solbot/backend metrics:cron || echo "⚠️  Failed to run metrics:cron (check if it's already running)"

echo ""
echo "✅ Done! Metrics should now be recalculating."
echo ""
echo "📊 Check status with:"
echo "   pm2 logs tradooor-metrics-worker --lines 20"
echo "   pm2 logs tradooor-metrics-cron --lines 20"
