#!/bin/bash

echo "🔍 Checking Tradooor system status..."
echo ""

# Check PM2 processes
echo "📊 PM2 Processes:"
pm2 list
echo ""

# Check if critical processes are running
echo "✅ Checking critical processes:"
CRITICAL_PROCESSES=(
  "tradooor-backend"
  "tradooor-frontend"
  "tradooor-normalized-trade-processor"
  "tradooor-metrics-cron"
)

for process in "${CRITICAL_PROCESSES[@]}"; do
  if pm2 list | grep -q "$process.*online"; then
    echo "  ✅ $process is online"
  else
    echo "  ❌ $process is NOT running!"
  fi
done

echo ""
echo "📋 Recent errors (last 20 lines):"
echo ""

# Check normalized trade processor errors
echo "🔴 Normalized Trade Processor Errors:"
pm2 logs tradooor-normalized-trade-processor --lines 20 --err 2>/dev/null | tail -20 || echo "  No recent errors"
echo ""

# Check backend errors
echo "🔴 Backend Errors:"
pm2 logs tradooor-backend --lines 20 --err 2>/dev/null | tail -20 || echo "  No recent errors"
echo ""

# Check metrics cron errors
echo "🔴 Metrics Cron Errors:"
pm2 logs tradooor-metrics-cron --lines 20 --err 2>/dev/null | tail -20 || echo "  No recent errors"
echo ""

# Check for critical errors in logs
echo "🚨 Critical Errors (last 50 lines):"
pm2 logs tradooor-normalized-trade-processor --lines 50 2>/dev/null | grep -i "CRITICAL\|Failed to save\|23502\|23503" | tail -10 || echo "  No critical errors found"
echo ""

echo "✅ System status check complete!"

