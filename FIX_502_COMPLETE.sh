#!/bin/bash
# Complete fix script for 502 errors

set -e

echo "=========================================="
echo "🔧 KOMPLETNÍ OPRAVA 502 CHYBY"
echo "=========================================="
echo ""

cd /opt/tradooor

echo "1️⃣ Pullni nejnovější změny..."
git pull origin master
echo ""

echo "2️⃣ Zastav všechny PM2 procesy..."
pm2 stop all
pm2 delete all 2>/dev/null || true
echo ""

echo "3️⃣ Zabit procesy na portu 3000 a 3001..."
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
lsof -ti:3001 | xargs kill -9 2>/dev/null || true
sleep 2
echo ""

echo "4️⃣ Smazat starý build..."
rm -rf apps/frontend/.next
echo ""

echo "5️⃣ Nainstalovat závislosti (pokud je potřeba)..."
pnpm install
echo ""

echo "6️⃣ Buildni frontend..."
cd apps/frontend
pnpm build
echo ""

if [ ! -f ".next/BUILD_ID" ]; then
  echo "❌ BUILD SELHAL! Zkontroluj výstup výše."
  exit 1
fi

echo "✅ Build úspěšný!"
echo ""

echo "7️⃣ Spusť backend..."
cd /opt/tradooor
pm2 start "pnpm --filter backend start" --name tradooor-backend
sleep 3
echo ""

echo "8️⃣ Spusť frontend..."
pm2 start "pnpm --filter frontend start" --name tradooor-frontend
sleep 3
echo ""

echo "9️⃣ Uložit PM2 konfiguraci..."
pm2 save
echo ""

echo "🔟 Zkontroluj status..."
pm2 list
echo ""

echo "1️⃣1️⃣ Test připojení..."
sleep 2
curl -s -o /dev/null -w "Frontend (3000): HTTP %{http_code}\n" http://localhost:3000 || echo "❌ Frontend neběží"
curl -s -o /dev/null -w "Backend (3001): HTTP %{http_code}\n" http://localhost:3001/health || echo "❌ Backend neběží"
echo ""

echo "1️⃣2️⃣ Zkontroluj porty..."
netstat -tuln | grep -E "3000|3001" || ss -tuln | grep -E "3000|3001"
echo ""

echo "=========================================="
echo "✅ OPRAVA DOKONČENA"
echo "=========================================="
echo ""
echo "Pokud stále máš 502, zkontroluj:"
echo "  - pm2 logs tradooor-frontend --lines 50"
echo "  - pm2 logs tradooor-backend --lines 50"
echo "  - tail -50 /var/log/nginx/error.log"
echo ""

