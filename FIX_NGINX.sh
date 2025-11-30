#!/bin/bash
# Fix Nginx configuration

set -e

echo "🔧 Fixing Nginx configuration..."

# 1. Update config from repo
cd /opt/tradooor
git pull origin master

# 2. Backup and copy new config
sudo cp /etc/nginx/sites-available/tradooor /etc/nginx/sites-available/tradooor.backup.$(date +%Y%m%d_%H%M%S) 2>/dev/null || true
sudo cp /opt/tradooor/nginx-tradooor.conf /etc/nginx/sites-available/tradooor

# 3. Enable site
sudo ln -sf /etc/nginx/sites-available/tradooor /etc/nginx/sites-enabled/tradooor
sudo rm -f /etc/nginx/sites-enabled/default

# 4. Test config
echo "🧪 Testing Nginx config..."
sudo nginx -t

# 5. Restart Nginx
echo "🔄 Restarting Nginx..."
sudo systemctl restart nginx

# 6. Check status
echo "📊 Status:"
echo "   Nginx: $(sudo systemctl is-active nginx)"
echo "   Backend: $(pm2 list | grep tradooor-backend | awk '{print $10}')"
echo "   Frontend: $(pm2 list | grep tradooor-frontend | awk '{print $10}')"

# 7. Test connections
echo ""
echo "🧪 Testing connections..."
echo "   Backend (3001): $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/health 2>/dev/null || echo 'FAILED')"
echo "   Frontend (3000): $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000 2>/dev/null || echo 'FAILED')"
echo "   Nginx (80): $(curl -s -o /dev/null -w '%{http_code}' http://localhost 2>/dev/null || echo 'FAILED')"

echo ""
echo "✅ Done! Check: sudo tail -f /var/log/nginx/tradooor-error.log"

