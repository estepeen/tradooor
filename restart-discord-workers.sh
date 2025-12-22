#!/bin/bash

# Restart workery pro Discord notifikace
# Tento skript restartuje workery, které posílají automatické Discord embedy

echo "🔄 Restartuji workery pro Discord notifikace..."

# Restart normalized-trade-processor (zpracovává trades a posílá signály)
echo "  📊 Restartuji tradooor-normalized-trade-processor..."
pm2 restart tradooor-normalized-trade-processor || echo "    ⚠️  Worker neběží, spouštím..."
pm2 start ecosystem.config.js --only tradooor-normalized-trade-processor 2>/dev/null || true

# Restart backend (může mít API endpointy pro signály)
echo "  🔧 Restartuji tradooor-backend..."
pm2 restart tradooor-backend || echo "    ⚠️  Backend neběží, spouštím..."
pm2 start ecosystem.config.js --only tradooor-backend 2>/dev/null || true

# Restart position-monitor (monitoruje pozice a posílá exit signály)
echo "  📈 Restartuji tradooor-position-monitor..."
pm2 restart tradooor-position-monitor || echo "    ⚠️  Position monitor neběží, spouštím..."
pm2 start ecosystem.config.js --only tradooor-position-monitor 2>/dev/null || true

echo ""
echo "✅ Workery restartovány!"
echo ""
echo "📊 Status workerů:"
pm2 list | grep -E "tradooor-(normalized-trade-processor|backend|position-monitor)"

echo ""
echo "📝 Pro zobrazení logů použij:"
echo "   pm2 logs tradooor-normalized-trade-processor --lines 50"
echo "   pm2 logs tradooor-backend --lines 50"
echo "   pm2 logs tradooor-position-monitor --lines 50"

