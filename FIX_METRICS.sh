#!/bin/bash
# Fix crashing metrics workers and recalculate metrics

set -e

echo "🔧 Fixing metrics workers..."

# 1. Check metrics worker logs
echo ""
echo "📋 Metrics Worker logs (last 30 lines):"
pm2 logs tradooor-metrics-worker --lines 30 --nostream 2>&1 | tail -30 || echo "No logs"

echo ""
echo "📋 Metrics Cron logs (last 30 lines):"
pm2 logs tradooor-metrics-cron --lines 30 --nostream 2>&1 | tail -30 || echo "No logs"

# 2. Stop crashing workers
echo ""
echo "🛑 Stopping metrics workers..."
pm2 stop tradooor-metrics-worker 2>/dev/null || true
pm2 stop tradooor-metrics-cron 2>/dev/null || true
pm2 delete tradooor-metrics-worker 2>/dev/null || true
pm2 delete tradooor-metrics-cron 2>/dev/null || true

# 3. Check backend logs for errors
echo ""
echo "📋 Backend logs (checking for errors):"
pm2 logs tradooor-backend --lines 50 --nostream 2>&1 | grep -i "error\|fail\|crash" | tail -10 || echo "No obvious errors in recent logs"

# 4. Try to manually calculate metrics for one wallet to see error
echo ""
echo "🧪 Testing metrics calculation..."
cd /opt/tradooor

# Get first wallet ID
FIRST_WALLET=$(cd apps/backend && pnpm --filter backend exec node -e "
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env' });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
supabase.from('SmartWallet').select('id').limit(1).single().then(({data}) => {
  if (data) console.log(data.id);
  else console.log('NO_WALLETS');
  process.exit(0);
}).catch(e => {
  console.log('ERROR');
  process.exit(1);
});
" 2>/dev/null || echo "ERROR")

if [ "$FIRST_WALLET" != "ERROR" ] && [ "$FIRST_WALLET" != "NO_WALLETS" ] && [ ! -z "$FIRST_WALLET" ]; then
    echo "   Testing with wallet: $FIRST_WALLET"
    cd apps/backend
    pnpm --filter backend calculate-metrics "$FIRST_WALLET" 2>&1 | head -20 || echo "   Calculation failed"
    cd ../..
else
    echo "   Could not get wallet ID for testing"
fi

# 5. Restart metrics workers (if they should run)
echo ""
echo "🚀 Restarting metrics workers..."
cd /opt/tradooor

# Check if workers should run - only start if backend is working
if pm2 list | grep -q "tradooor-backend.*online"; then
    echo "   Backend is running, starting metrics workers..."
    
    # Start metrics worker (if it exists)
    if [ -f "apps/backend/src/workers/wallet-processing-queue.ts" ]; then
        pm2 start "pnpm --filter backend metrics:worker" --name tradooor-metrics-worker || echo "   Metrics worker start failed"
    fi
    
    # Start metrics cron (if it exists)
    if [ -f "apps/backend/src/workers/metrics-cron.ts" ]; then
        pm2 start "pnpm --filter backend metrics:cron" --name tradooor-metrics-cron || echo "   Metrics cron start failed"
    fi
    
    sleep 3
else
    echo "   ⚠️  Backend is not running, skipping metrics workers"
fi

# 6. Manual metrics calculation for all wallets
echo ""
echo "🔄 Running manual metrics calculation for all wallets..."
cd /opt/tradooor/apps/backend
pnpm --filter backend calculate-metrics 2>&1 | tail -20 || echo "   Manual calculation failed"

# 7. Check PM2 status
echo ""
echo "📊 PM2 Status:"
pm2 list

# 8. Final check
echo ""
echo "✅ Done!"
echo ""
echo "🔍 Check metrics:"
echo "   - pm2 logs tradooor-metrics-worker"
echo "   - pm2 logs tradooor-metrics-cron"
echo "   - Check if PnL/score shows in web interface"
echo ""
echo "💡 If metrics still don't work, check:"
echo "   - Backend logs: pm2 logs tradooor-backend"
echo "   - Database connection"
echo "   - Environment variables"

