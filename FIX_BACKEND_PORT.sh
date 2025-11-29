#!/bin/bash

echo "🔧 Fixing backend port 3001 issue..."

# Stop all tradooor-backend processes
echo "1. Stopping all tradooor-backend processes..."
pm2 stop tradooor-backend 2>/dev/null || true
pm2 delete tradooor-backend 2>/dev/null || true

# Kill all processes on port 3001
echo "2. Killing all processes on port 3001..."
sudo kill -9 $(sudo lsof -t -i:3001) 2>/dev/null || echo "   No processes found on port 3001"

# Wait a bit
echo "3. Waiting 2 seconds..."
sleep 2

# Check if port is free
if sudo lsof -i :3001 > /dev/null 2>&1; then
    echo "   ⚠️  Port 3001 is still in use, trying to kill again..."
    sudo kill -9 $(sudo lsof -t -i:3001) 2>/dev/null || true
    sleep 2
fi

# Clean up any duplicate PM2 processes
echo "4. Cleaning up duplicate PM2 processes..."
pm2 delete tradooor-backend 2>/dev/null || true

# Start backend
echo "5. Starting backend..."
cd /opt/tradooor
pm2 start "pnpm --filter @solbot/backend start" --name tradooor-backend

# Save PM2 config
echo "6. Saving PM2 configuration..."
pm2 save

# Show status
echo ""
echo "✅ Done! Current status:"
pm2 status

echo ""
echo "📋 Recent logs:"
pm2 logs tradooor-backend --lines 10 --nostream

