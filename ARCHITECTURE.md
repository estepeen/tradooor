# Architektura projektu SolBot

## Přehled

SolBot je monorepo projekt pro sledování a analýzu smart wallets na Solaně. Projekt je rozdělen do několika částí:

## Struktura

```
solbot/
├── apps/
│   ├── backend/          # Node.js + Express API server
│   └── frontend/         # Next.js dashboard
├── packages/
│   ├── db/              # Prisma schéma a databázové utility
│   └── shared/          # Sdílené typy mezi backendem a frontendem
└── pnpm-workspace.yaml  # pnpm workspace konfigurace
```

## Backend (`apps/backend`)

### Struktura

- `src/index.ts` - Hlavní entry point, Express server
- `src/routes/` - API route handlers
  - `smart-wallets.ts` - Endpoints pro smart wallets
  - `trades.ts` - Endpoints pro trades
- `src/repositories/` - Data access layer
  - `smart-wallet.repository.ts` - CRUD pro smart wallets
  - `trade.repository.ts` - CRUD pro trades
  - `token.repository.ts` - CRUD pro tokens
  - `metrics-history.repository.ts` - CRUD pro metrics history
- `src/services/` - Business logic
  - `metrics-calculator.service.ts` - Výpočet metrik pro walletky
  - `solana-collector.service.ts` - Webhook handler pro nové swapy z Heliusu
- `src/workers/` - Background jobs
  - `calculate-metrics.ts` - CLI script pro přepočet metrik

### API Endpoints

#### Smart Wallets
- `GET /api/smart-wallets` - Seznam wallet (paginace, filtry, řazení)
- `GET /api/smart-wallets/:id` - Detail wallet s metrics history
- `POST /api/smart-wallets` - Vytvoření nové wallet

#### Trades
- `GET /api/trades?walletId=xxx` - Seznam tradeů pro wallet (paginace, filtry)

### Metriky

MetricsCalculatorService počítá následující metriky:

1. **Win Rate** - Procento ziskových pozic
2. **Average Risk/Reward** - Průměrný risk/reward poměr
3. **Average PnL %** - Průměrné procento zisku/ztráty na trade
4. **Total PnL** - Celkový zisk/ztráta v base měně
5. **Average Holding Time** - Průměrná doba držení pozice v minutách
6. **Max Drawdown** - Maximální pokles z vrcholu
7. **Recent PnL (30d)** - Celkový PnL za posledních 30 dní
8. **Score** - Celkové skóre kvality tradera (0-100)

Score je počítáno jako kombinace:
- Win Rate (max 30 bodů)
- Average PnL % (max 30 bodů)
- Recent PnL 30d (max 30 bodů)
- Volume/Trades count (max 10 bodů)

## Frontend (`apps/frontend`)

### Struktura

- `src/app/` - Next.js App Router
  - `page.tsx` - Homepage
  - `wallets/page.tsx` - Seznam smart wallets
  - `wallets/[id]/page.tsx` - Detail wallet s grafy a trades
- `src/lib/` - Utility funkce
  - `api.ts` - API client funkce
  - `utils.ts` - Formátovací utility

### Funkce

1. **Seznam wallet** (`/wallets`)
   - Tabulka s metrikami
   - Filtrování podle score, tagů, adresy
   - Řazení podle score, win rate, recent PnL
   - Paginace

2. **Detail wallet** (`/wallets/[id]`)
   - Základní informace a metriky
   - Grafy (score a PnL v čase)
   - Seznam posledních tradeů

## Databáze

### Schéma (Prisma)

1. **SmartWallet** - Trackované peněženky
   - Základní info (address, label, tags)
   - Aktuální metriky (score, win rate, PnL, atd.)

2. **Token** - Informace o tokenech
   - Mint address, symbol, name, decimals

3. **Trade** - Jednotlivé obchody
   - Transaction signature, wallet, token
   - Side (buy/sell), amounts, price, timestamp, DEX

4. **TokenMarketSnapshot** - Snapshoty trhu (volitelné)
   - Price, liquidity, volume, holders count

5. **SmartWalletMetricsHistory** - Historie metrik
   - Verzování metrik v čase pro grafy

## Workflow

### Přidání nové wallet

1. POST na `/api/smart-wallets` s adresou
2. Wallet je přidána do databáze s výchozími metrikami (0)

### Sběr dat (Helius webhook)

1. Helius pošle webhook → `routes/webhooks.ts`
2. `processHeliusWebhook` zjistí, kterých wallet se transakce týká
3. `SolanaCollectorService.processWebhookTransaction` normalizuje swap, uloží trade a přepočítá metriky

### Přepočet metrik

1. Spustí se worker: `pnpm --filter backend calculate-metrics`
2. Pro každou wallet:
   - Načte všechny trades
   - Sestaví pozice (párování buy/sell)
   - Spočítá metriky
   - Aktualizuje SmartWallet
   - Vytvoří záznam v SmartWalletMetricsHistory

### Zobrazení v dashboardu

1. Frontend načte seznam wallet přes API
2. Uživatel klikne na wallet → načte se detail s metrics history
3. Grafy zobrazí vývoj metrik v čase

## TODO / Budoucí rozšíření

### Webhook ingest
- [ ] Monitorovat výpadky webhooku (alert při absenci requestů)
- [ ] Idempotentní zpracování (deduplikace podle delivery ID)
- [ ] Retry queue, pokud uložený trade selže (např. DB outage)

### Automatizace
- [ ] Cron job pro automatický přepočet metrik (např. 1x denně)
- [ ] Queue systém pro náročné výpočty (např. údržba portfolia)

### Dashboard
- [ ] Více filtrů a statistik
- [ ] Export dat (CSV/JSON)
- [ ] Alerting systém
- [ ] Porovnání více wallet najednou

### Databáze
- [ ] Implementovat token market snapshots
- [ ] Optimalizace dotazů (indexy, caching)
- [ ] Archivace starých dat

