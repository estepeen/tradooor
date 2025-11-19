# Přidání sloupce positionChangePercent a přepočet hodnot

## Krok 1: Přidání sloupce do databáze

Otevři **Supabase Dashboard** → **SQL Editor** a spusť tento SQL:

```sql
ALTER TABLE "Trade" 
ADD COLUMN IF NOT EXISTS "positionChangePercent" DECIMAL(36, 18);

COMMENT ON COLUMN "Trade"."positionChangePercent" IS 'Percentage change in position size for this trade. Positive = buy (increased position), Negative = sell (decreased position)';
```

## Krok 2: Přepočet hodnot pro existující trendy

Po přidání sloupce spusť:

```bash
pnpm --filter backend position:recalculate
```

Tento script:
- Načte všechny walletky
- Pro každou walletku vypočítá `positionChangePercent` pro všechny trendy
- Aktualizuje hodnoty v databázi

## Co dělá positionChangePercent?

- **Pozitivní hodnoty** (např. `100` = `1.0x`): Koupě - kolik % současné pozice to představuje
- **Negativní hodnoty** (např. `-50` = `-0.5x`): Prodej - kolik % současné pozice bylo prodáno
- **100%** = **1.0x**: Koupě, která zdvojnásobí pozici (nebo první koupě)
- **-100%** = **-1.0x**: Prodej celé pozice

## Formát zobrazení

Na frontendu se zobrazuje jako násobek:
- `100%` → `+1.00x`
- `-50%` → `-0.50x`
- `200%` → `+2.00x`

