#!/bin/bash

# Script pro sběr dat a přepočet metrik
# Použití: ./scripts/collect-and-calculate.sh [LIMIT]

set -e

LIMIT=${1:-500}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "🚀 Spouštím sběr dat a přepočet metrik..."
echo "📊 Limit: $LIMIT transakcí na wallet"
echo ""

# Krok 1: Backfill historických dat
echo "📥 Krok 1/3: Backfill historických dat..."
pnpm --filter backend collector:backfill-all "$LIMIT"

echo ""
echo "✅ Backfill dokončen!"
echo ""

# Krok 2: Přepočet metrik
echo "📊 Krok 2/3: Přepočet metrik pro všechny wallets..."
pnpm --filter backend calculate-metrics

echo ""
echo "✅ Metriky přepočítány!"
echo ""

# Krok 3: Zobrazení statistik
echo "📈 Krok 3/3: Statistiky..."
echo ""
curl -s http://localhost:3001/api/trades 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    total = data.get('total', 0)
    print(f'✅ Celkem trades v databázi: {total}')
except:
    print('⚠️  Nelze načíst statistiky (backend možná neběží)')
" || echo "⚠️  Backend neběží nebo není dostupný"

echo ""
echo "🎉 Hotovo! Data by se měla zobrazovat v tabulce."
echo ""
echo "💡 Pro sledování nových transakcí spusť:"
echo "   pnpm --filter backend collector:start"
echo ""
echo "💡 Pro periodický přepočet metrik spusť:"
echo "   pnpm --filter backend metrics:cron"

