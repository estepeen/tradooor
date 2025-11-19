# Supabase Setup Guide

## Krok 1: Vytvoření Supabase projektu

1. Jdi na https://supabase.com a přihlas se (nebo vytvoř účet)
2. Klikni na "New Project"
3. Vyplň:
   - **Name**: tradooor (nebo jak chceš)
   - **Database Password**: Vygeneruj silné heslo (ulož si ho!)
   - **Region**: Vyber nejbližší region
4. Klikni "Create new project" a počkej ~2 minuty na vytvoření

## Krok 2: Získání Supabase credentials

1. V Supabase Dashboard klikni na **Project Settings** (ikona ozubeného kola)
2. V levém menu klikni na **API**
3. Zkopíruj následující hodnoty:
   - **Project URL** - vypadá jako `https://xxxxx.supabase.co`
   - **service_role key** (v sekci Project API keys) - **DŮLEŽITÉ:** Použij `service_role` key, ne `anon` key! Service role key má plná práva a obchází RLS (Row Level Security)

## Krok 3: Nastavení .env souboru

1. V projektu vytvoř soubor `apps/backend/.env`:
   ```bash
   # Vytvoř soubor pokud neexistuje
   touch apps/backend/.env
   ```

2. Otevři `apps/backend/.env` a přidej:
   ```env
   SUPABASE_URL="https://xxxxx.supabase.co"
   SUPABASE_SERVICE_ROLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
   SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"
   PORT=3001
   NODE_ENV=development
   ```

   **Důležité:** 
   - Nahraď `SUPABASE_URL` hodnotou z Project Settings > API > Project URL
   - Nahraď `SUPABASE_SERVICE_ROLE_KEY` hodnotou z Project Settings > API > service_role key
   - **NIKDY** nesdílej service_role key - má plná práva k databázi!

## Krok 4: Vytvoření databázového schématu

Projekt používá Supabase SDK místo Prisma, takže schéma musíš vytvořit ručně v Supabase Dashboard nebo přes SQL editor.

### Metoda 1: Přes SQL Editor (doporučeno)

1. V Supabase Dashboard klikni na **SQL Editor** v levém menu
2. Vytvoř nový query a vlož následující SQL:

```sql
-- SmartWallet table
CREATE TABLE IF NOT EXISTS "SmartWallet" (
  "id" TEXT PRIMARY KEY,
  "address" TEXT UNIQUE NOT NULL,
  "label" TEXT,
  "tags" TEXT[] DEFAULT '{}',
  "score" DOUBLE PRECISION DEFAULT 0,
  "totalTrades" INTEGER DEFAULT 0,
  "winRate" DOUBLE PRECISION DEFAULT 0,
  "avgRr" DOUBLE PRECISION DEFAULT 0,
  "avgPnlPercent" DOUBLE PRECISION DEFAULT 0,
  "pnlTotalBase" DOUBLE PRECISION DEFAULT 0,
  "avgHoldingTimeMin" DOUBLE PRECISION DEFAULT 0,
  "maxDrawdownPercent" DOUBLE PRECISION DEFAULT 0,
  "recentPnl30dPercent" DOUBLE PRECISION DEFAULT 0,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "SmartWallet_address_idx" ON "SmartWallet"("address");
CREATE INDEX IF NOT EXISTS "SmartWallet_score_idx" ON "SmartWallet"("score");
CREATE INDEX IF NOT EXISTS "SmartWallet_updatedAt_idx" ON "SmartWallet"("updatedAt");

-- Token table
CREATE TABLE IF NOT EXISTS "Token" (
  "id" TEXT PRIMARY KEY,
  "mintAddress" TEXT UNIQUE NOT NULL,
  "symbol" TEXT,
  "name" TEXT,
  "decimals" INTEGER DEFAULT 9,
  "firstSeenAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "Token_mintAddress_idx" ON "Token"("mintAddress");
CREATE INDEX IF NOT EXISTS "Token_symbol_idx" ON "Token"("symbol");

-- Trade table
CREATE TABLE IF NOT EXISTS "Trade" (
  "id" TEXT PRIMARY KEY,
  "txSignature" TEXT NOT NULL,
  "walletId" TEXT NOT NULL REFERENCES "SmartWallet"("id") ON DELETE CASCADE,
  "tokenId" TEXT NOT NULL REFERENCES "Token"("id") ON DELETE CASCADE,
  "side" TEXT NOT NULL,
  "amountToken" DECIMAL(36, 18) NOT NULL,
  "amountBase" DECIMAL(36, 18) NOT NULL,
  "priceBasePerToken" DECIMAL(36, 18) NOT NULL,
  "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL,
  "dex" TEXT NOT NULL,
  "positionId" TEXT,
  "meta" JSONB
);

CREATE INDEX IF NOT EXISTS "Trade_walletId_idx" ON "Trade"("walletId");
CREATE INDEX IF NOT EXISTS "Trade_tokenId_idx" ON "Trade"("tokenId");
CREATE INDEX IF NOT EXISTS "Trade_timestamp_idx" ON "Trade"("timestamp");
CREATE INDEX IF NOT EXISTS "Trade_txSignature_idx" ON "Trade"("txSignature");
CREATE INDEX IF NOT EXISTS "Trade_walletId_timestamp_idx" ON "Trade"("walletId", "timestamp");

-- TokenMarketSnapshot table
CREATE TABLE IF NOT EXISTS "TokenMarketSnapshot" (
  "id" TEXT PRIMARY KEY,
  "tokenId" TEXT NOT NULL REFERENCES "Token"("id") ON DELETE CASCADE,
  "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL,
  "price" DECIMAL(36, 18) NOT NULL,
  "liquidity" DECIMAL(36, 18) NOT NULL,
  "volume1m" DECIMAL(36, 18) NOT NULL,
  "volume5m" DECIMAL(36, 18) NOT NULL,
  "holdersCount" INTEGER,
  "smartWalletHolders" INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS "TokenMarketSnapshot_tokenId_idx" ON "TokenMarketSnapshot"("tokenId");
CREATE INDEX IF NOT EXISTS "TokenMarketSnapshot_timestamp_idx" ON "TokenMarketSnapshot"("timestamp");
CREATE INDEX IF NOT EXISTS "TokenMarketSnapshot_tokenId_timestamp_idx" ON "TokenMarketSnapshot"("tokenId", "timestamp");

-- SmartWalletMetricsHistory table
CREATE TABLE IF NOT EXISTS "SmartWalletMetricsHistory" (
  "id" TEXT PRIMARY KEY,
  "walletId" TEXT NOT NULL REFERENCES "SmartWallet"("id") ON DELETE CASCADE,
  "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL,
  "score" DOUBLE PRECISION NOT NULL,
  "totalTrades" INTEGER NOT NULL,
  "winRate" DOUBLE PRECISION NOT NULL,
  "avgRr" DOUBLE PRECISION NOT NULL,
  "avgPnlPercent" DOUBLE PRECISION NOT NULL,
  "pnlTotalBase" DOUBLE PRECISION NOT NULL,
  "avgHoldingTimeMin" DOUBLE PRECISION NOT NULL,
  "maxDrawdownPercent" DOUBLE PRECISION NOT NULL,
  "recentPnl30dPercent" DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS "SmartWalletMetricsHistory_walletId_idx" ON "SmartWalletMetricsHistory"("walletId");
CREATE INDEX IF NOT EXISTS "SmartWalletMetricsHistory_timestamp_idx" ON "SmartWalletMetricsHistory"("timestamp");
```

3. Klikni na **Run** (nebo Ctrl+Enter)
4. Měly by se vytvořit všechny tabulky a indexy

### Metoda 2: Přes Table Editor (ručně)

Můžeš vytvořit tabulky ručně přes Table Editor, ale to je zdlouhavé. Doporučuji Metodu 1.

## Krok 5: Ověření

1. V Supabase Dashboard klikni na **Table Editor** v levém menu
2. Měly by se zobrazit vytvořené tabulky:
   - `SmartWallet`
   - `Token`
   - `Trade`
   - `TokenMarketSnapshot`
   - `SmartWalletMetricsHistory`

## Tipy

- **Service Role Key**: Používá se pro backend operace a má plná práva (obchází RLS)
- **Anon Key**: Pro frontend aplikace s RLS policies (není potřeba pro tento projekt)
- **Backup**: Supabase automaticky zálohuje databázi každý den (na free tieru)
- **IPv6**: Supabase SDK komunikuje přes HTTP REST API, takže funguje i bez IPv6 podpory

## Troubleshooting

### "Missing Supabase environment variables"
- Zkontroluj, že máš `SUPABASE_URL` a `SUPABASE_SERVICE_ROLE_KEY` v `.env` souboru
- Ujisti se, že používáš **service_role** key, ne anon key

### "Failed to fetch" nebo "relation does not exist"
- Zkontroluj, že jsi vytvořil všechny tabulky (Krok 4)
- Ověř v Table Editor, že tabulky existují

### Rate limiting
- Supabase free tier má limity na počet requestů
- Pro produkci zvaž upgrade na Pro tier
