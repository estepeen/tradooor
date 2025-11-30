#!/bin/bash
# Fix crashing apps - check logs, remove duplicates, restart properly

set -e

echo "🔍 Diagnosing crashing applications..."

# 1. Check PM2 status
echo ""
echo "📊 PM2 Status:"
pm2 list

# 2. Check for duplicate frontend instances
echo ""
echo "🔍 Checking for duplicate processes..."
FRONTEND_COUNT=$(pm2 list | grep "tradooor-frontend" | wc -l)
if [ "$FRONTEND_COUNT" -gt 1 ]; then
    echo "⚠️  Found $FRONTEND_COUNT frontend instances - removing duplicates..."
    pm2 delete tradooor-frontend 2>/dev/null || true
    echo "✅ Duplicate frontend instances removed"
fi

# 3. Check backend logs for errors
echo ""
echo "📋 Backend logs (last 20 lines):"
pm2 logs tradooor-backend --lines 20 --nostream 2>&1 | tail -20 || echo "No backend logs"

# 4. Check frontend logs for errors
echo ""
echo "📋 Frontend logs (last 20 lines):"
pm2 logs tradooor-frontend --lines 20 --nostream 2>&1 | tail -20 || echo "No frontend logs"

# 5. Check if ports are in use
echo ""
echo "🔍 Checking ports..."
if netstat -tuln 2>/dev/null | grep -q ":3001"; then
    echo "✅ Port 3001 (backend) is in use"
else
    echo "❌ Port 3001 (backend) is NOT in use"
fi

if netstat -tuln 2>/dev/null | grep -q ":3000"; then
    echo "✅ Port 3000 (frontend) is in use"
else
    echo "❌ Port 3000 (frontend) is NOT in use"
fi

# 6. Check Nginx status
echo ""
echo "🔍 Checking Nginx status..."
if systemctl is-active --quiet nginx; then
    echo "✅ Nginx is running"
    sudo systemctl status nginx --no-pager -l | head -10
else
    echo "❌ Nginx is NOT running"
    echo "   Starting Nginx..."
    sudo systemctl start nginx
fi

# 7. Test backend connection
echo ""
echo "🧪 Testing backend connection..."
if curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health 2>/dev/null | grep -q "200\|404"; then
    echo "✅ Backend is responding"
else
    echo "❌ Backend is NOT responding"
fi

# 8. Test frontend connection
echo ""
echo "🧪 Testing frontend connection..."
if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 2>/dev/null | grep -q "200\|404"; then
    echo "✅ Frontend is responding"
else
    echo "❌ Frontend is NOT responding"
fi

# 9. Restart all services properly
echo ""
echo "🔄 Restarting services..."

# Stop all
pm2 stop all 2>/dev/null || true
sleep 2

# Remove all
pm2 delete all 2>/dev/null || true
sleep 2

# Start backend
echo "🚀 Starting backend..."
cd /opt/tradooor
pm2 start "pnpm --filter backend start" --name tradooor-backend
sleep 3

# Check if backend started
if pm2 list | grep -q "tradooor-backend.*online"; then
    echo "✅ Backend started successfully"
else
    echo "❌ Backend failed to start - check logs:"
    pm2 logs tradooor-backend --lines 30 --nostream
    exit 1
fi

# Start frontend
echo "🚀 Starting frontend..."
cd /opt/tradooor
pm2 start "pnpm --filter frontend start" --name tradooor-frontend
sleep 3

# Check if frontend started
if pm2 list | grep -q "tradooor-frontend.*online"; then
    echo "✅ Frontend started successfully"
else
    echo "❌ Frontend failed to start - check logs:"
    pm2 logs tradooor-frontend --lines 30 --nostream
    exit 1
fi

# Save PM2 config
pm2 save

# 10. Restart Nginx
echo ""
echo "🔄 Restarting Nginx..."
sudo systemctl restart nginx

# 11. Final status
echo ""
echo "📊 Final Status:"
pm2 list
echo ""
echo "✅ Done! Check if services are running:"
echo "   - pm2 logs tradooor-backend"
echo "   - pm2 logs tradooor-frontend"
echo "   - curl http://localhost:3001/health"
echo "   - curl http://localhost:3000"

