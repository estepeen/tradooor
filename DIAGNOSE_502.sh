#!/bin/bash
# Comprehensive diagnostic script for 502 errors

echo "=========================================="
echo "🔍 DIAGNOSTIKA 502 CHYBY"
echo "=========================================="
echo ""

echo "1️⃣ PM2 Status:"
echo "----------------------------------------"
pm2 list
echo ""

echo "2️⃣ Porty (3000, 3001):"
echo "----------------------------------------"
netstat -tuln | grep -E "3000|3001" || ss -tuln | grep -E "3000|3001" || echo "❌ Žádný proces neběží na portu 3000 nebo 3001"
echo ""

echo "3️⃣ Frontend build (.next folder):"
echo "----------------------------------------"
if [ -d "/opt/tradooor/apps/frontend/.next" ]; then
  echo "✅ .next folder existuje"
  if [ -f "/opt/tradooor/apps/frontend/.next/BUILD_ID" ]; then
    echo "✅ BUILD_ID existuje"
    cat /opt/tradooor/apps/frontend/.next/BUILD_ID
  else
    echo "❌ BUILD_ID NEEXISTUJE - build selhal nebo není dokončen"
  fi
else
  echo "❌ .next folder NEEXISTUJE - frontend nebyl buildnut"
fi
echo ""

echo "4️⃣ Frontend logy (posledních 30 řádků):"
echo "----------------------------------------"
pm2 logs tradooor-frontend --lines 30 --nostream 2>&1 | tail -30
echo ""

echo "5️⃣ Backend logy (posledních 20 řádků):"
echo "----------------------------------------"
pm2 logs tradooor-backend --lines 20 --nostream 2>&1 | tail -20
echo ""

echo "6️⃣ Nginx status:"
echo "----------------------------------------"
systemctl status nginx --no-pager -l | head -20 || service nginx status | head -20
echo ""

echo "7️⃣ Nginx error logy (posledních 20 řádků):"
echo "----------------------------------------"
tail -20 /var/log/nginx/error.log 2>/dev/null || echo "❌ Nelze číst Nginx error log"
echo ""

echo "8️⃣ Test připojení na localhost:3000:"
echo "----------------------------------------"
curl -s -o /dev/null -w "HTTP Status: %{http_code}\n" http://localhost:3000 || echo "❌ Nelze se připojit na localhost:3000"
echo ""

echo "9️⃣ Test připojení na localhost:3001:"
echo "----------------------------------------"
curl -s -o /dev/null -w "HTTP Status: %{http_code}\n" http://localhost:3001/health || echo "❌ Nelze se připojit na localhost:3001"
echo ""

echo "🔟 Procesy na portu 3000:"
echo "----------------------------------------"
lsof -i:3000 2>/dev/null || fuser 3000/tcp 2>/dev/null || echo "Žádný proces na portu 3000"
echo ""

echo "=========================================="
echo "✅ DIAGNOSTIKA DOKONČENA"
echo "=========================================="

