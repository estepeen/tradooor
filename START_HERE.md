# 🚀 Jak spustit aplikaci

## Krok 1: Nastavení databáze (pokud ještě není)

1. Otevři Supabase Dashboard: https://supabase.com
2. Vytvoř projekt (nebo použij existující)
3. Zkopíruj **Connection pooling** string z Project Settings > Database
4. Vytvoř soubor `apps/backend/.env`:
   ```bash
   DATABASE_URL="postgresql://postgres.myiqdbvtmzpboegzteua:[PASSWORD]@aws-1-eu-north-1.pooler.supabase.com:6543/postgres"
   SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"
   PORT=3001
   NODE_ENV=development
   ```
5. Spusť migrace:
   ```bash
   pnpm db:migrate
   ```

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

### Metoda 3: Přes Prisma Studio (GUI)

```bash
pnpm db:studio
```

Otevře se na http://localhost:5555 - můžeš přidat wallet přímo v databázi.

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
- **Prisma Studio:** http://localhost:5555 (po spuštění `pnpm db:studio`)

## ❓ Troubleshooting

**Backend neběží?**
- Zkontroluj `.env` v `apps/backend/` s `DATABASE_URL`
- Zkontroluj, že databáze běží (Supabase)

**Frontend neběží?**
- Zkontroluj, že backend běží na portu 3001
- Zkontroluj `.env.local` v `apps/frontend/` (mělo by být automaticky vytvořené)

**Chyba při přidání wallet?**
- Zkontroluj, že adresa je validní Solana address (44 znaků)
- Zkontroluj, že wallet ještě není v databázi

