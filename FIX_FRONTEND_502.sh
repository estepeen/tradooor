#!/bin/bash
# Fix script for frontend 502 errors

echo "🔍 Checking frontend logs..."
pm2 logs tradooor-frontend --lines 50 --nostream

echo ""
echo "🔍 Checking if frontend build exists..."
ls -la /opt/tradooor/apps/frontend/.next 2>/dev/null || echo "❌ .next folder not found - frontend needs to be built!"

echo ""
echo "🔍 Checking frontend process on port 3000..."
netstat -tuln | grep 3000 || ss -tuln | grep 3000 || echo "❌ Nothing listening on port 3000"

echo ""
echo "🔧 Fixing steps:"
echo ""
echo "1. Stop all frontend processes:"
echo "   pm2 stop tradooor-frontend"
echo "   pm2 delete tradooor-frontend"
echo ""
echo "2. Build frontend:"
echo "   cd /opt/tradooor/apps/frontend"
echo "   pnpm build"
echo ""
echo "3. Start frontend:"
echo "   pm2 start 'pnpm --filter frontend start' --name tradooor-frontend"
echo "   pm2 save"
echo ""
echo "4. Check if it's running:"
echo "   netstat -tuln | grep 3000"
echo "   pm2 logs tradooor-frontend --lines 20"

