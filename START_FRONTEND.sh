#!/bin/bash
# Start frontend and check status

set -e

echo "=========================================="
echo "🚀 SPUŠTĚNÍ FRONTENDU"
echo "=========================================="
echo ""

cd /opt/tradooor

echo "1️⃣ Zastav a smaž starý frontend proces..."
pm2 stop tradooor-frontend 2>/dev/null || true
pm2 delete tradooor-frontend 2>/dev/null || true
echo ""

echo "2️⃣ Zabit procesy na portu 3000..."
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
sleep 2
echo ""

echo "3️⃣ Zkontroluj BUILD_ID..."
if [ ! -f "apps/frontend/.next/BUILD_ID" ]; then
  echo "❌ BUILD_ID neexistuje! Musíš nejdřív buildnout:"
  echo "   cd apps/frontend && pnpm build"
  exit 1
fi
echo "✅ BUILD_ID existuje: $(cat apps/frontend/.next/BUILD_ID)"
echo ""

echo "4️⃣ Spusť frontend..."
pm2 start "pnpm --filter frontend start" --name tradooor-frontend
sleep 5
echo ""

echo "5️⃣ Zkontroluj status..."
pm2 list | grep tradooor-frontend
echo ""

echo "6️⃣ Zkontroluj port 3000..."
if netstat -tuln | grep 3000 || ss -tuln | grep 3000; then
  echo "✅ Port 3000 je otevřený"
else
  echo "❌ Port 3000 není otevřený"
fi
echo ""

echo "7️⃣ Test připojení..."
sleep 2
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 || echo "000")
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "000" ]; then
  if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ Frontend odpovídá (HTTP $HTTP_CODE)"
  else
    echo "❌ Frontend neodpovídá"
  fi
else
  echo "⚠️  Frontend odpovídá s kódem: $HTTP_CODE"
fi
echo ""

echo "8️⃣ Logy frontendu (posledních 20 řádků):"
echo "----------------------------------------"
pm2 logs tradooor-frontend --lines 20 --nostream 2>&1 | tail -20
echo ""

echo "=========================================="
echo "✅ HOTOVO"
echo "=========================================="
echo ""
echo "Pokud frontend neběží, zkontroluj:"
echo "  - pm2 logs tradooor-frontend --lines 50"
echo "  - cd apps/frontend && pnpm build (pokud BUILD_ID neexistuje)"
echo ""

