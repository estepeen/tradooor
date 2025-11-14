# Quick Start Guide

## 1. Spuštění aplikace

### Backend (API server)

```bash
# V terminálu 1
cd /Users/stepanpanek/Desktop/Coding/Bots/solbot
pnpm --filter backend dev
```

Backend poběží na: http://localhost:3001

### Frontend (Dashboard)

```bash
# V terminálu 2
cd /Users/stepanpanek/Desktop/Coding/Bots/solbot
pnpm --filter frontend dev
```

Frontend poběží na: http://localhost:3000

### Nebo oba najednou

```bash
pnpm dev
```

## 2. Přidání Smart Wallet

### Metoda 1: Přes Dashboard (nejjednodušší)

1. Otevři http://localhost:3000
2. Klikni na "Add Wallet" (pokud je tlačítko) nebo použij API přímo

### Metoda 2: Přes API (curl)

```bash
curl -X POST http://localhost:3001/api/smart-wallets \
  -H "Content-Type: application/json" \
  -d '{
    "address": "TVALID_SOLANA_WALLET_ADDRESS",
    "label": "My Trader",
    "tags": ["degen", "sniper"]
  }'
```

**Příklad:**
```bash
curl -X POST http://localhost:3001/api/smart-wallets \
  -H "Content-Type: application/json" \
  -d '{
    "address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    "label": "Example Trader",
    "tags": ["degen"]
  }'
```

### Metoda 3: Přes Prisma Studio (GUI)

```bash
pnpm db:studio
```

Otevře se na http://localhost:5555 - můžeš přidat wallet přímo v databázi.

## 3. Zobrazení wallet

Po přidání wallet:
1. Otevři http://localhost:3000/wallets
2. Uvidíš seznam všech přidaných wallet
3. Klikni na wallet pro detail

## 4. Sledování transakcí (volitelné)

```bash
# Spustit Solana Collector (sleduje transakce)
pnpm --filter backend collector:start
```

## 5. Přepočet metrik

```bash
# Jednorázový přepočet
pnpm --filter backend calculate-metrics

# Nebo periodický cron job
pnpm --filter backend metrics:cron
```

## Troubleshooting

### Backend neběží
- Zkontroluj, že máš `.env` soubor v `apps/backend/` s `DATABASE_URL`
- Zkontroluj, že databáze běží (Supabase)

### Frontend neběží
- Zkontroluj, že backend běží na portu 3001
- Zkontroluj `.env.local` v `apps/frontend/` s `NEXT_PUBLIC_API_URL=http://localhost:3001/api`

### Chyba při přidání wallet
- Zkontroluj, že adresa je validní Solana address
- Zkontroluj, že wallet ještě není v databázi

