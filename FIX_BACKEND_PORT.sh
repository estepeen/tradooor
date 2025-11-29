#!/bin/bash

echo "🔧 Fixing backend port 3001 issue..."

# Find PM2 path (usually in /usr/bin/pm2 or via npx)
PM2_CMD="pm2"
if ! command -v pm2 &> /dev/null; then
    if [ -f /usr/bin/pm2 ]; then
        PM2_CMD="/usr/bin/pm2"
    elif [ -f ~/.local/share/pnpm/pm2 ]; then
        PM2_CMD="~/.local/share/pnpm/pm2"
    else
        PM2_CMD="npx pm2"
    fi
fi

echo "   Using PM2 command: $PM2_CMD"

# Stop all tradooor-backend processes
echo "1. Stopping all tradooor-backend processes..."
$PM2_CMD stop tradooor-backend 2>/dev/null || true
$PM2_CMD delete tradooor-backend 2>/dev/null || true

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
$PM2_CMD delete tradooor-backend 2>/dev/null || true

# Start backend
echo "5. Starting backend..."
cd /opt/tradooor
$PM2_CMD start "pnpm --filter @solbot/backend start" --name tradooor-backend

# Save PM2 config
echo "6. Saving PM2 configuration..."
$PM2_CMD save

# Show status
echo ""
echo "✅ Done! Current status:"
$PM2_CMD status

echo ""
echo "📋 Recent logs:"
$PM2_CMD logs tradooor-backend --lines 10 --nostream

