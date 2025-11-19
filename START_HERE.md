# 🚀 Jak spustit aplikaci

## Krok 1: Nastavení databáze (pokud ještě není)

1. Otevři Supabase Dashboard: https://supabase.com
2. Vytvoř projekt (nebo použij existující)
3. V **Project Settings > API** zkopíruj:
   - **Project URL** (např. `https://xxxxx.supabase.co`)
   - **service_role key** (v sekci Project API keys)
4. Vytvoř soubor `apps/backend/.env`:
   ```env
   SUPABASE_URL="https://xxxxx.supabase.co"
   SUPABASE_SERVICE_ROLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
   SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"
   PORT=3001
   NODE_ENV=development
   ```
5. Vytvoř databázové schéma - viz [SUPABASE_SETUP.md](./SUPABASE_SETUP.md) Krok 4

## Krok 2: Spuštění aplikace

### Varianta A: Oba najednou (doporučeno)

```bash
pnpm dev
```

Toto spustí:
- Backend na http://localhost:3001
- Frontend na http://localhost:3000

### Varianta B: Samostatně

**Terminál 1 - Backend:**
```bash
pnpm dev:backend
```

**Terminál 2 - Frontend:**
```bash
pnpm dev:frontend
```

## Krok 3: Přidání Smart Wallet

### Metoda 1: Přes Dashboard (nejjednodušší) ⭐

1. Otevři http://localhost:3000
2. Klikni na **"+ Add Wallet"** (vpravo nahoře)
3. Vyplň:
   - **Wallet Address** - Solana wallet address (povinné)
   - **Label** - volitelné jméno (např. "My Trader")
   - **Tags** - volitelné tagy oddělené čárkou (např. "degen, sniper")
4. Klikni **"Add Wallet"**

### Metoda 2: Přes API (curl)

```bash
curl -X POST http://localhost:3001/api/smart-wallets \
  -H "Content-Type: application/json" \
  -d '{
    "address": "TVALID_SOLANA_ADDRESS",
    "label": "My Trader",
    "tags": ["degen", "sniper"]
  }'
```

### Metoda 3: Přes Supabase Dashboard

1. Otevři Supabase Dashboard > Table Editor
2. Vyber tabulku `SmartWallet`
3. Klikni "Insert row" a vyplň data

## Krok 4: Zobrazení wallet

1. Otevři http://localhost:3000/wallets
2. Uvidíš seznam všech přidaných wallet
3. Klikni na wallet pro detail s grafy a tradey

## Volitelné: Sledování transakcí

```bash
# Spustit Solana Collector (sleduje nové transakce)
pnpm --filter backend collector:start

# Backfill historických transakcí pro wallet
pnpm --filter backend collector:backfill WALLET_ADDRESS 100
```

## Volitelné: Přepočet metrik

```bash
# Jednorázový přepočet pro všechny walletky
pnpm --filter backend calculate-metrics

# Periodický cron job (každých 6 hodin)
pnpm --filter backend metrics:cron
```

## 📝 Poznámky

- **Backend API:** http://localhost:3001
- **Frontend Dashboard:** http://localhost:3000
- **Supabase Dashboard:** https://supabase.com/dashboard

## ❓ Troubleshooting

**Backend neběží?**
- Zkontroluj `.env` v `apps/backend/` s `SUPABASE_URL` a `SUPABASE_SERVICE_ROLE_KEY`
- Zkontroluj, že databáze běží (Supabase Dashboard)
- Zkontroluj, že máš vytvořené všechny tabulky (viz SUPABASE_SETUP.md)

**Frontend neběží?**
- Zkontroluj, že backend běží na portu 3001
- Zkontroluj `.env.local` v `apps/frontend/` (mělo by být automaticky vytvořené)

**Chyba při přidání wallet?**
- Zkontroluj, že adresa je validní Solana address (44 znaků)
- Zkontroluj, že wallet ještě není v databázi
- Zkontroluj Supabase Dashboard > Logs pro detaily chyb
