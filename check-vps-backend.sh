#!/bin/bash

# Quick check script for VPS backend status

echo "🔍 Checking VPS Backend Status..."
echo ""

# Check if API is accessible
echo "1. Testing API endpoint..."
API_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "http://157.180.41.49/api/smart-wallets?page=1&pageSize=1" 2>/dev/null)

if [ "$API_RESPONSE" = "200" ]; then
  echo "   ✅ API is accessible (HTTP $API_RESPONSE)"
elif [ "$API_RESPONSE" = "502" ]; then
  echo "   ❌ API returns 502 Bad Gateway - Backend is not running!"
  echo ""
  echo "   🔧 To fix, SSH to VPS and run:"
  echo "      ssh root@157.180.41.49"
  echo "      cd /opt/tradooor"
  echo "      pm2 restart tradooor-backend"
  echo "      # or if not running:"
  echo "      pm2 start \"pnpm --filter backend start\" --name tradooor-backend"
elif [ "$API_RESPONSE" = "000" ]; then
  echo "   ❌ Cannot connect to API - Server might be down"
else
  echo "   ⚠️  API returned HTTP $API_RESPONSE"
fi

echo ""
echo "2. Testing health endpoint..."
HEALTH_RESPONSE=$(curl -s "http://157.180.41.49/health" 2>/dev/null)
if [ -n "$HEALTH_RESPONSE" ]; then
  echo "   Response: $HEALTH_RESPONSE"
else
  echo "   ❌ Health endpoint not responding"
fi

echo ""
echo "📋 Next steps:"
echo "   1. SSH to VPS: ssh root@157.180.41.49"
echo "   2. Check PM2: pm2 status"
echo "   3. Check logs: pm2 logs tradooor-backend"
echo "   4. Restart if needed: pm2 restart tradooor-backend"

