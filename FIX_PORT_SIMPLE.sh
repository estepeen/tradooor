#!/bin/bash

echo "🔧 Fixing port 3001 - step by step..."

# Step 1: Stop all PM2 processes
echo "1. Stopping all PM2 processes..."
pm2 stop all 2>/dev/null || true
sleep 1

# Step 2: Delete backend process
echo "2. Deleting tradooor-backend process..."
pm2 delete tradooor-backend 2>/dev/null || true
sleep 1

# Step 3: Kill all processes on port 3001
echo "3. Killing all processes on port 3001..."
PIDS=$(sudo lsof -t -i:3001 2>/dev/null || true)
if [ ! -z "$PIDS" ]; then
    echo "   Found PIDs: $PIDS"
    echo "$PIDS" | xargs -r sudo kill -9
else
    echo "   No processes found on port 3001"
fi

# Step 4: Wait longer
echo "4. Waiting 5 seconds for processes to fully terminate..."
sleep 5

# Step 5: Double check and kill again if needed
PIDS=$(sudo lsof -t -i:3001 2>/dev/null || true)
if [ ! -z "$PIDS" ]; then
    echo "   ⚠️  Still found processes, killing again..."
    echo "$PIDS" | xargs -r sudo kill -9
    sleep 3
fi

# Step 6: Verify port is free
if sudo lsof -i :3001 > /dev/null 2>&1; then
    echo "   ❌ Port 3001 is STILL in use. Manual intervention needed."
    echo "   Run: sudo lsof -i :3001"
    exit 1
else
    echo "   ✅ Port 3001 is free"
fi

# Step 7: Start backend
echo "5. Starting backend..."
cd /opt/tradooor
pm2 start "pnpm --filter @solbot/backend start" --name tradooor-backend

# Step 8: Save
echo "6. Saving PM2 configuration..."
pm2 save

# Step 9: Show status
echo ""
echo "✅ Done! Status:"
pm2 status

echo ""
echo "📋 Last 20 lines of logs:"
sleep 2
pm2 logs tradooor-backend --lines 20 --nostream

