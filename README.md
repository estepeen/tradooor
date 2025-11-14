# SolBot - Smart Wallet Tracking & Analytics Platform

Backend + dashboard pro sledování a vyhodnocování smart wallets na Solaně.

## Struktura projektu

- `apps/backend` - Node.js + TypeScript backend s API a workers
- `apps/frontend` - Next.js dashboard
- `packages/shared` - Sdílené typy a utility
- `packages/db` - Prisma schéma a databázové utility

## Setup

### Požadavky

- Node.js >= 18.0.0
- pnpm >= 8.0.0
- Supabase účet (nebo PostgreSQL databáze)

### Instalace

1. Instalace závislostí:
```bash
pnpm install
```

2. Nastavení databáze (Supabase):
```bash
# Vytvoř účet na https://supabase.com a nový projekt
# V Project Settings > Database najdeš Connection String
# Použij "Connection pooling" nebo "Direct connection" string

# Vytvoř .env soubor v apps/backend:
# DATABASE_URL="postgresql://postgres:[PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres"
# SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"
# PORT=3001
# NODE_ENV=development

# Vygeneruj Prisma client
pnpm db:generate

# Spusť migrace
pnpm db:migrate
```

**Poznámka:** Supabase používá standardní PostgreSQL, takže Prisma funguje bez změn. Connection string najdeš v Supabase Dashboard > Project Settings > Database.

3. Nastavení frontendu:
```bash
# Vytvoř .env.local v apps/frontend
# NEXT_PUBLIC_API_URL=http://localhost:3001/api
```

4. Spuštění vývoje:
```bash
# Spustí backend i frontend současně
pnpm dev

# Nebo samostatně:
pnpm --filter backend dev
pnpm --filter frontend dev
```

### Použití

#### Přidání smart wallet

Přidej wallet přes API:
```bash
curl -X POST http://localhost:3001/api/smart-wallets \
  -H "Content-Type: application/json" \
  -d '{
    "address": "YOUR_WALLET_ADDRESS",
    "label": "My Trader",
    "tags": ["degen", "sniper"]
  }'
```

#### Přepočet metrik

```bash
# Jednorázový přepočet pro všechny walletky
pnpm --filter backend calculate-metrics

# Pro konkrétní wallet
pnpm --filter backend calculate-metrics WALLET_ID

# Periodický cron job (každých 6 hodin, lze změnit přes CRON_SCHEDULE)
pnpm --filter backend metrics:cron
```

#### Solana Collector (sledování transakcí)

```bash
# Spustit collector pro sledování transakcí
pnpm --filter backend collector:start

# Backfill historických transakcí pro wallet
pnpm --filter backend collector:backfill WALLET_ADDRESS [LIMIT]
```

#### Prisma Studio (databázový GUI)

```bash
pnpm db:studio
```

## Databázové schéma

- **smart_wallets** - Trackované peněženky s metrikami
- **tokens** - Informace o tokenech
- **trades** - Jednotlivé obchody
- **token_market_snapshots** - Snapshoty trhu (volitelné)
- **smart_wallet_metrics_history** - Historie metrik v čase

## API Endpoints

- `GET /api/smart-wallets` - Seznam wallet (s paginací a filtry)
- `GET /api/smart-wallets/:id` - Detail wallet
- `POST /api/smart-wallets` - Vytvoření nové wallet
- `GET /api/trades?walletId=xxx` - Seznam tradeů pro wallet

## Tech Stack

- **Backend**: Node.js + TypeScript + Express
- **Database**: Supabase (PostgreSQL) + Prisma ORM
- **Frontend**: Next.js + React + TypeScript + Tailwind CSS
- **Solana**: @solana/web3.js
- **Charts**: Recharts

### Proč Supabase?

- ✅ Bezplatná tier s generosními limity
- ✅ Snadný setup - žádná lokální instalace PostgreSQL
- ✅ Web dashboard pro správu databáze
- ✅ Automatické zálohy
- ✅ Možnost rozšíření o Auth, Storage, Realtime (v budoucnu)
- ✅ Standardní PostgreSQL - funguje s Prisma bez změn

## TODO / Budoucí rozšíření

- [ ] Implementovat plnou logiku Solana collectoru (parsing swap transakcí)
- [ ] Přidat cron job pro automatický přepočet metrik
- [ ] Implementovat token market snapshots
- [ ] Přidat více filtrů a statistik do dashboardu
- [ ] Export dat do CSV/JSON
- [ ] Alerting systém

