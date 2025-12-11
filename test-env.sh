#!/bin/bash

# Test script pro ověření .env konfigurace na serveru

echo "🧪 Testing environment configuration..."
echo ""

# 1. Test DATABASE_URL
echo "1️⃣  Testing DATABASE_URL (Prisma)..."
cd /opt/tradooor
if pnpm --filter @solbot/db db:generate > /tmp/test-db.log 2>&1; then
  echo "   ✅ DATABASE_URL works!"
else
  echo "   ❌ DATABASE_URL failed - check /tmp/test-db.log"
  cat /tmp/test-db.log | tail -5
fi
echo ""

# 2. Test QuickNode RPC
echo "2️⃣  Testing QuickNode RPC..."
cd /opt/tradooor/apps/backend
if node -e "
require('dotenv').config();
const { Connection } = require('@solana/web3.js');
const rpc = process.env.QUICKNODE_RPC_URL || process.env.SOLANA_RPC_URL;
if (!rpc) { console.error('⚠️  QUICKNODE_RPC_URL or SOLANA_RPC_URL not set'); process.exit(1); }
const conn = new Connection(rpc, 'confirmed');
conn.getSlot().then(slot => { console.log('✅ RPC works! Slot:', slot); process.exit(0); }).catch(e => { console.error('❌ RPC error:', e.message); process.exit(1); });
" 2>&1; then
  echo "   ✅ QuickNode RPC works!"
else
  echo "   ⚠️  QuickNode RPC not configured (QUICKNODE_RPC_URL or SOLANA_RPC_URL missing)"
fi
echo ""

# 3. Test Supabase
echo "3️⃣  Testing Supabase connection..."
cd /opt/tradooor/apps/backend
if node -e "
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
supabase.from('SmartWallet').select('id, address, twitterUrl').limit(1).then(({ data, error }) => {
  if (error) { console.error('❌ Supabase error:', error.message); process.exit(1); }
  else { console.log('✅ Supabase works! Found', data?.length || 0, 'wallets'); process.exit(0); }
});
" 2>&1; then
  echo "   ✅ Supabase works!"
else
  echo "   ❌ Supabase failed"
fi
echo ""

# 4. Test Backend API
echo "4️⃣  Testing Backend API..."
if curl -s http://localhost:3001/api/smart-wallets?pageSize=1 | grep -q "wallets\|error"; then
  echo "   ✅ Backend API responds!"
else
  echo "   ❌ Backend API not responding (check if backend is running)"
fi
echo ""

# 5. Test Frontend
echo "5️⃣  Testing Frontend..."
if curl -s http://localhost:3000 | grep -q "html\|<!DOCTYPE"; then
  echo "   ✅ Frontend responds!"
else
  echo "   ❌ Frontend not responding (check if frontend is running)"
fi
echo ""

# 6. Check processes
echo "6️⃣  Checking running processes..."
BACKEND_PIDS=$(ps aux | grep -E "tsx.*src/index.ts" | grep -v grep | wc -l)
FRONTEND_PIDS=$(ps aux | grep -E "next.*start" | grep -v grep | wc -l)
BACKFILL_PIDS=$(ps aux | grep -E "tsx.*backfill-cron" | grep -v grep | wc -l)

echo "   Backend processes: $BACKEND_PIDS"
echo "   Frontend processes: $FRONTEND_PIDS"
echo "   Backfill cron processes: $BACKFILL_PIDS"
echo ""

echo "✅ Test complete!"
echo ""
echo "📋 Logs location:"
echo "   Backend: /tmp/backend.log"
echo "   Frontend: /tmp/frontend.log"
echo "   Backfill cron: /tmp/backfill-cron.log"

