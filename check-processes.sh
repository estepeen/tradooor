#!/bin/bash

# Script pro kontrolu běžících procesů

echo "🔍 Checking running processes..."
echo ""

echo "📊 Backend processes (tsx src/index.ts):"
ps aux | grep -E "tsx.*src/index.ts" | grep -v grep | awk '{print $2, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20}'
echo ""

echo "📊 Frontend processes (next start):"
ps aux | grep -E "next.*start" | grep -v grep | awk '{print $2, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20}'
echo ""

echo "📊 Backfill cron processes:"
ps aux | grep -E "tsx.*backfill-cron" | grep -v grep | awk '{print $2, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20}'
echo ""

echo "📊 Metrics cron processes:"
ps aux | grep -E "tsx.*metrics-cron" | grep -v grep | awk '{print $2, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20}'
echo ""

echo "📊 Normalized trade processor processes:"
ps aux | grep -E "tsx.*normalized-trade-processor" | grep -v grep | awk '{print $2, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20}'
echo ""

echo "💡 Expected processes:"
echo "   - 1x Backend (tsx src/index.ts)"
echo "   - 1x Frontend (next start)"
echo "   - 1x Backfill cron (tsx src/workers/backfill-cron.ts)"
echo "   - 1x Metrics cron (tsx src/workers/metrics-cron.ts)"
echo "   - 1x Normalized trade processor (tsx src/workers/normalized-trade-processor.ts)"
echo ""
echo "   Total: ~5 processes"
echo ""

