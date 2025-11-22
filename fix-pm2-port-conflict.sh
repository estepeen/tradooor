#!/bin/bash

# Script to fix PM2 port conflict and restart backend

echo "🔧 Fixing PM2 port conflict..."

# 1. Stop and delete all tradooor-backend processes
echo "1. Stopping all tradooor-backend processes..."
pm2 stop tradooor-backend 2>/dev/null || true
pm2 delete tradooor-backend 2>/dev/null || true

# 2. Wait a moment
sleep 2

# 3. Check if port 3001 is still in use
echo "2. Checking port 3001..."
PORT_PID=$(lsof -ti :3001 2>/dev/null || echo "")

if [ -n "$PORT_PID" ]; then
  echo "   ⚠️  Port 3001 is still in use by PID: $PORT_PID"
  echo "   Killing process..."
  kill -9 $PORT_PID 2>/dev/null || true
  sleep 1
else
  echo "   ✅ Port 3001 is free"
fi

# 4. Double check - kill any remaining node processes on port 3001
echo "3. Double-checking port 3001..."
REMAINING=$(lsof -ti :3001 2>/dev/null || echo "")
if [ -n "$REMAINING" ]; then
  echo "   ⚠️  Still in use, killing all processes on port 3001..."
  kill -9 $REMAINING 2>/dev/null || true
  sleep 1
fi

# 5. Check PM2 status
echo "4. Checking PM2 status..."
pm2 status

# 6. Start backend
echo "5. Starting backend..."
cd /opt/tradooor
pm2 start "pnpm --filter backend start" --name tradooor-backend

# 7. Save PM2 config
echo "6. Saving PM2 config..."
pm2 save

# 8. Wait a moment and check status
sleep 3
echo ""
echo "7. Final PM2 status:"
pm2 status

echo ""
echo "8. Checking if backend is responding..."
sleep 2
curl -s http://localhost:3001/health | head -c 200 || echo "   ❌ Backend not responding"

echo ""
echo "✅ Done! Check logs with: pm2 logs tradooor-backend"

