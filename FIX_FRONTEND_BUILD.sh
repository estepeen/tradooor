#!/bin/bash
# Fix frontend build issue

set -e

echo "=========================================="
echo "🔧 OPRAVA FRONTEND BUILDU"
echo "=========================================="
echo ""

cd /opt/tradooor

echo "1️⃣ Zastav frontend..."
pm2 stop tradooor-frontend 2>/dev/null || true
pm2 delete tradooor-frontend 2>/dev/null || true
echo ""

echo "2️⃣ Zabit procesy na portu 3000..."
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
sleep 2
echo ""

echo "3️⃣ Smaž starý build..."
rm -rf apps/frontend/.next
rm -rf apps/frontend/node_modules/.cache
echo ""

echo "4️⃣ Zkontroluj, jestli jsou závislosti nainstalované..."
if [ ! -d "node_modules" ] || [ ! -d "apps/frontend/node_modules" ]; then
  echo "Instaluji závislosti..."
  pnpm install
else
  echo "✅ Závislosti jsou nainstalované"
fi
echo ""

echo "5️⃣ Buildni frontend (s výstupem)..."
cd apps/frontend
pnpm build 2>&1 | tee /tmp/frontend-build.log
echo ""

if [ ! -f ".next/BUILD_ID" ]; then
  echo "❌ BUILD SELHAL!"
  echo "Zkontroluj log: /tmp/frontend-build.log"
  echo ""
  echo "Posledních 50 řádků z build logu:"
  tail -50 /tmp/frontend-build.log
  exit 1
fi

echo "✅ Build úspěšný! BUILD_ID:"
cat .next/BUILD_ID
echo ""

echo "6️⃣ Spusť frontend..."
cd /opt/tradooor
pm2 start "pnpm --filter frontend start" --name tradooor-frontend
sleep 5
echo ""

echo "7️⃣ Zkontroluj status..."
pm2 list | grep tradooor-frontend
echo ""

echo "8️⃣ Zkontroluj port 3000..."
netstat -tuln | grep 3000 || ss -tuln | grep 3000
echo ""

echo "9️⃣ Test připojení..."
sleep 2
curl -s -o /dev/null -w "HTTP Status: %{http_code}\n" http://localhost:3000 || echo "❌ Frontend neběží"
echo ""

echo "=========================================="
echo "✅ OPRAVA DOKONČENA"
echo "=========================================="
echo ""
echo "Pokud stále nefunguje, zkontroluj:"
echo "  - pm2 logs tradooor-frontend --lines 50"
echo "  - cat /tmp/frontend-build.log"
echo ""

