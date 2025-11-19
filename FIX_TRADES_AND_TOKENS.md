# Oprava špatně detekovaných tradeů a tokenů

## Problémy

1. **Position sloupec**: Zobrazuje nesmyslné hodnoty jako `-168.81x` (což je `-16881%`)
   - Problém: Když je `currentPosition` velmi malé, `positionChangePercent` se počítá jako extrémní hodnota
   - ✅ **OPRAVENO**: Přidána omezení - maximálně `-100%` (prodej celé pozice) až `+1000%` (10x)

2. **Názvy tokenů**: Zobrazují se jako base tokeny (USDC/USDT/SOL) místo skutečných tokenů
   - Problém: Když někdo prodá TRUMP za SOL, který se převádí na USDC, systém to detekuje jako BUY USDC místo SELL TRUMP
   - ✅ **OPRAVENO**: Prioritizace SELL tokenu před BUY base tokenu v detekci

## Postup opravy

### Krok 1: Přepočet Position pro existující trendy

```bash
pnpm --filter backend position:recalculate
```

Tento script:
- Přepočítá `positionChangePercent` pro všechny existující trendy
- Omezí extrémní hodnoty na rozumné limity (-100% až +1000%)

### Krok 2: Najít a smazat špatně detekované trendy

```bash
pnpm --filter backend fix:trades WALLET_ADDRESS --delete-only
```

Nahraď `WALLET_ADDRESS` skutečnou adresou walletky (např. `6p6xgHz1kpEGN3jL8fP5kLwKLHw7QffgJfGiPN`)

Tento script:
- Najde trendy typu BUY pro base tokeny (USDC/USDT/SOL)
- Smaže je z databáze
- **NESPOUŠTÍ** backfill (pouze smaže)

### Krok 3: Spustit backfill znovu pro danou walletku

```bash
pnpm --filter backend collector:backfill WALLET_ADDRESS 100
```

Tento script:
- Načte posledních 100 transakcí pro danou walletku
- Zpracuje je s opravenou detekcí (SELL tokenu má prioritu před BUY base tokenu)
- Uloží trendy s opravenými hodnotami

### Kompletní oprava (vše v jednom)

```bash
# 1. Přepočet position
pnpm --filter backend position:recalculate

# 2. Pro každou walletku:
pnpm --filter backend fix:trades WALLET_ADDRESS --delete-only
pnpm --filter backend collector:backfill WALLET_ADDRESS 100

# Pro všechny walletky najednou:
# (manuálně pro každou walletku nebo vytvořte loop)
```

## Co bylo opraveno v kódu

### 1. Omezení positionChangePercent

```typescript
// Omez na maximálně -100% (celý prodej pozice)
if (positionChangePercent < -100) {
  positionChangePercent = -100;
}

// Pokud je abs(positionChangePercent) velmi velké (více než 1000%), je to pravděpodobně chyba
if (Math.abs(positionChangePercent) > 1000) {
  positionChangePercent = -100; // Považuj za prodej celé pozice
}
```

### 2. Prioritizace SELL před BUY

V `helius-client.service.ts`:
- Nejprve kontrolujeme, zda je input token (SELL)
- Pak kontrolujeme, zda je output token (BUY)
- To zajišťuje, že prodej tokenu má prioritu před koupí base tokenu

## Poznámky

- Nové trendy budou automaticky detekovány správně
- Existující trendy potřebují přepočet pomocí `position:recalculate`
- Špatně detekované trendy (BUY USDC místo SELL tokenu) musí být smazány a načteny znovu

