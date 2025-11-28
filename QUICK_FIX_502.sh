#!/bin/bash
# Quick fix script for 502 Bad Gateway errors

echo "🔍 Checking PM2 processes..."
pm2 list

echo ""
echo "🔍 Checking if backend is listening on port 3001..."
netstat -tuln | grep 3001 || ss -tuln | grep 3001

echo ""
echo "🔍 Checking if frontend is listening on port 3000..."
netstat -tuln | grep 3000 || ss -tuln | grep 3000

echo ""
echo "🔍 Checking backend logs (last 20 lines)..."
pm2 logs tradooor-backend --lines 20 --nostream

echo ""
echo "🔍 Checking frontend logs (last 20 lines)..."
pm2 logs tradooor-frontend --lines 20 --nostream

echo ""
echo "🔍 Checking Nginx error logs (last 10 lines)..."
sudo tail -10 /var/log/nginx/error.log

echo ""
echo "📋 Quick fix commands:"
echo "  # Restart backend:"
echo "  pm2 restart tradooor-backend"
echo ""
echo "  # Restart frontend:"
echo "  pm2 restart tradooor-frontend"
echo ""
echo "  # Restart Nginx:"
echo "  sudo systemctl reload nginx"
echo ""
echo "  # If processes are not running, start them:"
echo "  cd /opt/tradooor"
echo "  pm2 start 'pnpm --filter backend start' --name tradooor-backend"
echo "  pm2 start 'pnpm --filter frontend start' --name tradooor-frontend"
echo "  pm2 save"

