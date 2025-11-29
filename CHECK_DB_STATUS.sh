#!/bin/bash

echo "🔍 Checking database status and metrics..."
echo ""

cd /opt/tradooor

echo "Running database status check..."
pnpm --filter @solbot/backend check:db-status

echo ""
echo "✅ Check complete!"
