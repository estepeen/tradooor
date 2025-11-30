#!/bin/bash
# Fix static files 400 error - Update Nginx to properly route to frontend

set -e

echo "🔧 Fixing static files routing in Nginx..."

# 1. Backup current Nginx config
echo "📦 Backing up current Nginx config..."
sudo cp /etc/nginx/sites-available/tradooor /etc/nginx/sites-available/tradooor.backup.$(date +%Y%m%d_%H%M%S)

# 2. Copy new Nginx config from repo
echo "📝 Copying new Nginx config..."
cd /opt/tradooor
git pull origin master
sudo cp /opt/tradooor/nginx-tradooor.conf /etc/nginx/sites-available/tradooor

# 3. Test Nginx config
echo "🧪 Testing Nginx configuration..."
if sudo nginx -t; then
    echo "✅ Nginx configuration is valid"
else
    echo "❌ Nginx configuration has errors!"
    exit 1
fi

# 4. Check if frontend is running
echo "🔍 Checking if frontend is running..."
if pm2 list | grep -q "tradooor-frontend.*online"; then
    echo "✅ Frontend is running"
    FRONTEND_PORT=$(pm2 info tradooor-frontend | grep "exec cwd" || echo "")
    echo "   Frontend process found"
else
    echo "⚠️  Frontend is not running!"
    echo "   Starting frontend..."
    cd /opt/tradooor
    pm2 start "pnpm --filter frontend start" --name tradooor-frontend
    pm2 save
    echo "✅ Frontend started"
fi

# 5. Check if backend is running
echo "🔍 Checking if backend is running..."
if pm2 list | grep -q "tradooor-backend.*online"; then
    echo "✅ Backend is running"
else
    echo "⚠️  Backend is not running!"
    echo "   Starting backend..."
    cd /opt/tradooor
    pm2 start "pnpm --filter backend start" --name tradooor-backend
    pm2 save
    echo "✅ Backend started"
fi

# 6. Restart Nginx
echo "🔄 Restarting Nginx..."
sudo systemctl restart nginx

# 7. Check Nginx status
echo "📊 Checking Nginx status..."
if sudo systemctl is-active --quiet nginx; then
    echo "✅ Nginx is running"
else
    echo "❌ Nginx is not running!"
    exit 1
fi

# 8. Test static files
echo "🧪 Testing static files routing..."
echo "   Testing /_next/static path..."
if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/_next/static/css/ 2>/dev/null | grep -q "200\|404"; then
    echo "✅ Frontend is responding on port 3000"
else
    echo "⚠️  Frontend might not be responding correctly on port 3000"
    echo "   Check: pm2 logs tradooor-frontend"
fi

echo ""
echo "✅ Done! Nginx configuration updated."
echo ""
echo "📋 Summary:"
echo "   - Nginx config updated"
echo "   - Frontend should be on port 3000"
echo "   - Backend should be on port 3001"
echo "   - Static files (/_next/*) route to frontend"
echo "   - API (/api/*) routes to backend"
echo ""
echo "🔍 To verify, check:"
echo "   - pm2 list"
echo "   - sudo systemctl status nginx"
echo "   - curl http://localhost:3000/_next/static/css/"
echo ""

