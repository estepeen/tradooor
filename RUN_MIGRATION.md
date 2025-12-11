# Spuštění SQL migrace pro OpenPosition tabulku

## Možnost 1: Přes psql (pokud máš DATABASE_URL v .env)

```bash
# Z .env načti DATABASE_URL a spusť SQL
psql "$DATABASE_URL" -f ADD_OPEN_POSITIONS.sql
```

Nebo přímo:

```bash
psql "postgresql://[user]:[password]@[host]:[port]/[database]" -f ADD_OPEN_POSITIONS.sql
```

## Možnost 2: Přes Supabase CLI

```bash
# Pokud máš Supabase CLI nainstalované
supabase db push

# Nebo přímo SQL
supabase db execute -f ADD_OPEN_POSITIONS.sql
```

## Možnost 3: Přes Supabase Dashboard (nejjednodušší)

1. Otevři Supabase Dashboard: https://supabase.com/dashboard
2. Vyber svůj projekt
3. Jdi na **SQL Editor**
4. Vlož obsah souboru `ADD_OPEN_POSITIONS.sql`
5. Klikni na **Run**

## Možnost 4: Přes psql s .env souborem

```bash
# Načti DATABASE_URL z .env a spusť SQL
source .env
psql "$DATABASE_URL" < ADD_OPEN_POSITIONS.sql
```

## Ověření, že to funguje

Po spuštění migrace můžeš zkontrolovat:

```sql
-- Zkontroluj, že tabulka existuje
SELECT * FROM "OpenPosition" LIMIT 5;

-- Zkontroluj strukturu tabulky
\d "OpenPosition"
```

## Po migraci

1. Restartuj backend: `pnpm dev:backend`
2. (Volitelně) Spusť přepočet pro existující wallets:
   ```bash
   pnpm --filter backend recalculate-all-positions
   ```
