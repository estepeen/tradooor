# Supabase Setup Guide

## Krok 1: Vytvoření Supabase projektu

1. Jdi na https://supabase.com a přihlas se (nebo vytvoř účet)
2. Klikni na "New Project"
3. Vyplň:
   - **Name**: solbot (nebo jak chceš)
   - **Database Password**: Vygeneruj silné heslo (ulož si ho!)
   - **Region**: Vyber nejbližší region
4. Klikni "Create new project" a počkej ~2 minuty na vytvoření

## Krok 2: Získání Connection String

1. V Supabase Dashboard klikni na **Project Settings** (ikona ozubeného kola)
2. V levém menu klikni na **Database**
3. Scrolluj dolů k sekci **Connection string**
4. Vyber **Connection pooling** (doporučeno pro produkci) nebo **Direct connection** (pro vývoj)
5. Zkopíruj connection string - vypadá nějak takto:
   ```
   postgresql://postgres.xxxxx:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres
   ```
   nebo pro direct connection:
   ```
   postgresql://postgres:[YOUR-PASSWORD]@db.xxxxx.supabase.co:5432/postgres
   ```

## Krok 3: Nastavení .env souboru

1. V projektu vytvoř soubor `apps/backend/.env`:
   ```bash
   cp apps/backend/.env.example apps/backend/.env
   ```

2. Otevři `apps/backend/.env` a uprav:
   ```env
   DATABASE_URL="postgresql://postgres:[YOUR-PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres"
   SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"
   PORT=3001
   NODE_ENV=development
   ```

   **Důležité:** Nahraď `[YOUR-PASSWORD]` a `[PROJECT-REF]` hodnotami z Supabase!

## Krok 4: Spuštění migrací

```bash
# Vygeneruj Prisma client
pnpm db:generate

# Spusť migrace (vytvoří tabulky v Supabase)
pnpm db:migrate
```

Při prvním spuštění migrace Prisma se zeptá na název migrace - zadej např. `init`.

## Krok 5: Ověření

1. V Supabase Dashboard klikni na **Table Editor** v levém menu
2. Měly by se zobrazit vytvořené tabulky:
   - `SmartWallet`
   - `Token`
   - `Trade`
   - `TokenMarketSnapshot`
   - `SmartWalletMetricsHistory`

## Bonus: Prisma Studio s Supabase

Můžeš použít Prisma Studio pro prohlížení dat:

```bash
pnpm db:studio
```

Otevře se na http://localhost:5555 a můžeš procházet data přímo z Supabase.

## Tipy

- **Connection Pooling**: Pro produkci používej connection pooling string - je optimalizovaný pro více souběžných připojení
- **Direct Connection**: Pro vývoj a Prisma Studio používej direct connection
- **Heslo**: Ulož si heslo do password manageru - Supabase ho už nezobrazí
- **Backup**: Supabase automaticky zálohuje databázi každý den (na free tieru)

## Troubleshooting

### "Connection refused" nebo timeout
- Zkontroluj, že jsi použil správný connection string
- Ověř, že heslo je správné (bez mezer na začátku/konci)
- Zkus použít direct connection místo pooling

### "Schema not found"
- Ujisti se, že connection string obsahuje správný database name (obvykle `postgres`)
- Zkontroluj, že migrace proběhla úspěšně

### Rate limiting
- Supabase free tier má limity na počet requestů
- Pro produkci zvaž upgrade na Pro tier

