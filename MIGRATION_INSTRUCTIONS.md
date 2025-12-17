# Instrukce pro přidání createdAt a updatedAt do ClosedLot

**NEPOUŽÍVEJTE `db push`** - může smazat důležitá data!

Místo toho použijte jeden z těchto přístupů:

## Možnost 1: Přímý SQL příkaz (nejrychlejší)

```bash
cd /opt/tradooor

# Přidej createdAt a updatedAt sloupce (pokud ještě neexistují)
psql $DATABASE_URL << 'SQL'
-- Přidat createdAt pokud neexistuje
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'ClosedLot' AND column_name = 'createdAt'
  ) THEN
    ALTER TABLE "ClosedLot" ADD COLUMN "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW();
  END IF;
END $$;

-- Přidat updatedAt pokud neexistuje
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'ClosedLot' AND column_name = 'updatedAt'
  ) THEN
    ALTER TABLE "ClosedLot" ADD COLUMN "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    
    -- Vytvořit trigger pro automatické aktualizování updatedAt
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW."updatedAt" = NOW();
      RETURN NEW;
    END;
    $$ language 'plpgsql';
    
    DROP TRIGGER IF EXISTS update_closed_lot_updated_at ON "ClosedLot";
    CREATE TRIGGER update_closed_lot_updated_at
      BEFORE UPDATE ON "ClosedLot"
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
SQL

# Regeneruj Prisma client
cd packages/db
pnpm db:generate

# Rebuild backend
cd ../../apps/backend
pnpm build

# Restart
cd /opt/tradooor
pm2 restart tradooor-normalized-trade-processor
```

## Možnost 2: Prisma migrace (pokud chcete mít historii)

```bash
cd /opt/tradooor/packages/db

# Vytvoř migraci (bez spuštění)
pnpm db:migrate dev --name add_created_at_updated_at_to_closed_lot --create-only

# Uprav migrační soubor v prisma/migrations/.../migration.sql
# Přidej jen:
# ALTER TABLE "ClosedLot" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW();
# ALTER TABLE "ClosedLot" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW();

# Spusť migraci
pnpm db:migrate deploy

# Regeneruj Prisma client
pnpm db:generate
```

## Důležité poznámky

- `db push` by smazal sloupce `notificationSent`, `positionStatus`, `priority` z `Signal` tabulky
- `db push` by smazal tabulky `OpenPosition` a `TraderBehaviorProfile`
- Pokud tyto sloupce/tabulky potřebujete, přidejte je zpět do Prisma schématu před použitím `db push`

