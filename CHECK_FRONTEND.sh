#!/bin/bash
# Check frontend status and fix if needed

echo "=========================================="
echo "🔍 KONTROLA FRONTENDU"
echo "=========================================="
echo ""

echo "1️⃣ PM2 Status frontendu:"
echo "----------------------------------------"
pm2 list | grep tradooor-frontend
echo ""

echo "2️⃣ Port 3000:"
echo "----------------------------------------"
netstat -tuln | grep 3000 || ss -tuln | grep 3000 || echo "❌ Nic neběží na portu 3000"
echo ""

echo "3️⃣ Procesy na portu 3000:"
echo "----------------------------------------"
lsof -i:3000 2>/dev/null || fuser 3000/tcp 2>/dev/null || echo "Žádný proces na portu 3000"
echo ""

echo "4️⃣ Frontend logy (posledních 30 řádků):"
echo "----------------------------------------"
pm2 logs tradooor-frontend --lines 30 --nostream 2>&1 | tail -30
echo ""

echo "5️⃣ Test připojení na localhost:3000:"
echo "----------------------------------------"
curl -s -o /dev/null -w "HTTP Status: %{http_code}\n" http://localhost:3000 || echo "❌ Nelze se připojit"
echo ""

echo "6️⃣ BUILD_ID existuje:"
echo "----------------------------------------"
if [ -f "/opt/tradooor/apps/frontend/.next/BUILD_ID" ]; then
  echo "✅ BUILD_ID existuje:"
  cat /opt/tradooor/apps/frontend/.next/BUILD_ID
else
  echo "❌ BUILD_ID NEEXISTUJE"
fi
echo ""

echo "=========================================="
echo "🔧 POKUD FRONTEND NEBĚŽÍ:"
echo "=========================================="
echo ""
echo "cd /opt/tradooor"
echo "pm2 stop tradooor-frontend"
echo "pm2 delete tradooor-frontend"
echo "pm2 start \"pnpm --filter frontend start\" --name tradooor-frontend"
echo "pm2 save"
echo ""

