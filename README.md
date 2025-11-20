# SolBot - Smart Wallet Tracking & Analytics Platform

Backend + dashboard for tracking and analyzing smart wallets on Solana.

## Project Structure

- `apps/backend` - Node.js + TypeScript backend with API and workers
- `apps/frontend` - Next.js dashboard
- `packages/shared` - Shared types and utilities
- `packages/db` - Prisma schema and database utilities

## Setup

### Requirements

- Node.js >= 18.0.0
- pnpm >= 8.0.0
- Supabase account (or PostgreSQL database)

### Installation

1. Install dependencies:
```bash
pnpm install
```

2. Database setup (Supabase):
```bash
# Create account at https://supabase.com and new project
# In Project Settings > Database you'll find Connection String
# Use "Connection pooling" or "Direct connection" string

# Create .env file in apps/backend:
# DATABASE_URL="postgresql://postgres:[PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres"
# SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"
# PORT=3001
# NODE_ENV=development

# Generate Prisma client
pnpm db:generate

# Run migrations
pnpm db:migrate
```

**Note:** Supabase uses standard PostgreSQL, so Prisma works without changes. Connection string can be found in Supabase Dashboard > Project Settings > Database.

3. Frontend setup:
```bash
# Create .env.local in apps/frontend
# NEXT_PUBLIC_API_URL=http://localhost:3001/api
```

4. Start development:
```bash
# Starts both backend and frontend simultaneously
pnpm dev

# Or separately:
pnpm --filter backend dev
pnpm --filter frontend dev
```

### Usage

#### Adding smart wallet

Add wallet via API:
```bash
curl -X POST http://localhost:3001/api/smart-wallets \
  -H "Content-Type: application/json" \
  -d '{
    "address": "YOUR_WALLET_ADDRESS",
    "label": "My Trader",
    "tags": ["degen", "sniper"]
  }'
```

#### Recalculate metrics

```bash
# One-time recalculation for all wallets
pnpm --filter backend calculate-metrics

# For specific wallet
pnpm --filter backend calculate-metrics WALLET_ID

# Periodic cron job (every 6 hours, can be changed via CRON_SCHEDULE)
pnpm --filter backend metrics:cron
```

#### Solana Collector (transaction tracking)

```bash
# Start collector for tracking transactions
pnpm --filter backend collector:start

# Backfill historical transactions for wallet
pnpm --filter backend collector:backfill WALLET_ADDRESS [LIMIT]
```

#### Prisma Studio (database GUI)

```bash
pnpm db:studio
```

## Database Schema

- **smart_wallets** - Tracked wallets with metrics
- **tokens** - Token information
- **trades** - Individual trades
- **token_market_snapshots** - Market snapshots (optional)
- **smart_wallet_metrics_history** - Metrics history over time

## API Endpoints

- `GET /api/smart-wallets` - List wallets (with pagination and filters)
- `GET /api/smart-wallets/:id` - Wallet details
- `POST /api/smart-wallets` - Create new wallet
- `GET /api/trades?walletId=xxx` - List trades for wallet

## Tech Stack

- **Backend**: Node.js + TypeScript + Express
- **Database**: Supabase (PostgreSQL) + Prisma ORM
- **Frontend**: Next.js + React + TypeScript + Tailwind CSS
- **Solana**: @solana/web3.js
- **Charts**: Recharts

### Why Supabase?

- ✅ Free tier with generous limits
- ✅ Easy setup - no local PostgreSQL installation
- ✅ Web dashboard for database management
- ✅ Automatic backups
- ✅ Option to extend with Auth, Storage, Realtime (in future)
- ✅ Standard PostgreSQL - works with Prisma without changes

## TODO / Future Extensions

- [ ] Implement full Solana collector logic (parsing swap transactions)
- [ ] Add cron job for automatic metrics recalculation
- [ ] Implement token market snapshots
- [ ] Add more filters and statistics to dashboard
- [ ] Export data to CSV/JSON
- [ ] Alerting system
