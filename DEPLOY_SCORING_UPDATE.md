# Deployment Instructions: 7d/30d Hybrid Scoring System

## Overview
This deployment adds the new 7d/30d hybrid scoring system that addresses:
- ✅ Optimized scoring for memecoin volatility (70% 7d, 30% 30d)
- ✅ Sample confidence penalty for traders with few trades
- ✅ Position size factor (±5 points)
- ✅ Lowered signal tier thresholds to match realistic score distribution
- ✅ Web UI updates showing Score 7d and Score 30d columns

## Quick Deploy (Recommended)

SSH into your VPS and run:

```bash
ssh root@165.227.163.188
cd /opt/tradooor
./deploy-scoring-update.sh
```

## Manual Deployment Steps

If the automated script doesn't exist or fails, follow these steps:

### 1. Connect to VPS
```bash
ssh root@165.227.163.188
```

### 2. Navigate to project directory
```bash
cd /opt/tradooor
```

### 3. Pull latest code
```bash
git pull origin master
```

Expected output: Should show the commit `662af90 - feat: Implement 7d/30d hybrid scoring system`

### 4. Run database migration
```bash
psql -U postgres -d tradooor_db -f migrations/add_score_7d_30d_columns.sql
```

Expected output:
```
ALTER TABLE
ALTER TABLE
ALTER TABLE
ALTER TABLE
COMMENT
COMMENT
COMMENT
COMMENT
```

### 5. Generate Prisma client
```bash
cd packages/db
npx prisma generate
cd /opt/tradooor
```

Expected output: `Generated Prisma Client (v5.22.0)`

### 6. Install dependencies (if needed)
```bash
pnpm install --frozen-lockfile
```

### 7. Build backend
```bash
pnpm --filter backend build
```

Expected output: Should complete without TypeScript errors

### 8. Restart PM2 services
```bash
pm2 restart tradooor-backend
pm2 restart tradooor-metrics-cron
```

### 9. Check service status
```bash
pm2 status
pm2 logs tradooor-backend --lines 30
pm2 logs tradooor-metrics-cron --lines 30
```

### 10. Verify database migration
```bash
psql -U postgres -d tradooor_db -c "\d \"SmartWallet\"" | grep -E "score7d|score30d|recentPnl7d"
```

Expected output should show the new columns:
```
 score7d                     | double precision |           | not null | 0
 score30d                    | double precision |           | not null | 0
 recentPnl7dPercent          | double precision |           | not null | 0
 recentPnl7dBase             | double precision |           | not null | 0
```

### 11. Trigger score recalculation
```bash
pnpm --filter backend metrics:cron
```

This will recalculate all wallet scores with the new formula.

## Verification

### Check Website
1. Visit https://tradooor.stepanpanek.cz
2. Verify the trader table shows two new columns: "Score 7d" and "Score 30d"
3. Click on a trader to see the detail page
4. Verify the Score box shows the breakdown: "7d: XX.X" and "30d: XX.X"

### Check Scores
Top traders should now have scores in the 40-60 range (previously unrealistic high thresholds)

### Check Signals
Monitor Discord for signals. Signals should now be generated for top traders who previously didn't meet the 65-70 thresholds.

## Troubleshooting

### Website still showing old data
```bash
# Clear browser cache or hard refresh (Cmd+Shift+R on Mac, Ctrl+Shift+R on Windows)
```

### Scores not updated
```bash
# Force recalculation
pm2 logs tradooor-metrics-cron --lines 50
pnpm --filter backend metrics:cron
```

### Backend errors
```bash
# Check logs
pm2 logs tradooor-backend --lines 100

# Restart if needed
pm2 restart tradooor-backend
```

### Database migration failed
```bash
# Check if columns already exist
psql -U postgres -d tradooor_db -c "\d \"SmartWallet\"" | grep score7d

# If migration partially applied, you may need to run specific ALTER TABLE commands
```

## Rollback (if needed)

If something goes wrong:

```bash
# 1. Checkout previous commit
git checkout e44b432

# 2. Rebuild
pnpm --filter backend build

# 3. Restart services
pm2 restart tradooor-backend
pm2 restart tradooor-metrics-cron

# 4. Remove new columns (optional - they won't hurt anything)
psql -U postgres -d tradooor_db -c 'ALTER TABLE "SmartWallet" DROP COLUMN IF EXISTS "score7d", DROP COLUMN IF EXISTS "score30d", DROP COLUMN IF EXISTS "recentPnl7dPercent", DROP COLUMN IF EXISTS "recentPnl7dBase";'
```

## Files Changed

- `packages/db/prisma/schema.prisma` - Added score7d, score30d, recentPnl7dPercent, recentPnl7dBase
- `migrations/add_score_7d_30d_columns.sql` - Database migration
- `apps/backend/src/services/metrics-calculator.service.ts` - New scoring formula
- `apps/backend/src/repositories/smart-wallet.repository.ts` - Updated repository methods
- `apps/backend/src/services/advanced-signals.service.ts` - Lowered tier thresholds
- `apps/frontend/src/app/page.tsx` - Added Score 7d and Score 30d columns
- `apps/frontend/src/app/wallet/[address]/page.tsx` - Added score breakdown to detail page
