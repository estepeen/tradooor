# Token-to-Token Swaps - Implementační plán

## Aktuální stav

Token-to-token swapy se detekují, ale označují jako `void` a přeskočí se v lot matching.

## Co by bylo potřeba

### 1. Rozšířit `SolanaCollectorService` (střední náročnost)

**Soubor:** `apps/backend/src/services/solana-collector.service.ts`

**Změny:**
- Místo označení jako `void`, získat ceny obou tokenů z Birdeye API
- Vypočítat `valueUsd` a `priceBasePerToken` v USD
- Nastavit `baseToken: 'USD'` místo `'VOID'`

**Kód:**
```typescript
// Místo:
side = 'void';
baseToken = 'VOID';

// Udělat:
const tokenInPrice = await tokenPriceService.getTokenPriceAtDate(tokenInMint, timestamp);
const tokenOutPrice = await tokenPriceService.getTokenPriceAtDate(tokenOutMint, timestamp);

if (tokenInPrice && tokenOutPrice) {
  // Vypočítat hodnotu swapu v USD
  const valueInUsd = amountIn * tokenInPrice;
  const valueOutUsd = amountOut * tokenOutPrice;
  const valueUsd = (valueInUsd + valueOutUsd) / 2; // Průměr
  
  // Pro BUY: použij hodnotu výstupního tokenu
  // Pro SELL: použij hodnotu vstupního tokenu
  baseAmount = valueUsd;
  baseToken = 'USD';
  priceBasePerToken = valueUsd / amountToken;
} else {
  // Fallback: označit jako void, pokud ceny nejsou dostupné
  side = 'void';
  baseToken = 'VOID';
}
```

**Náročnost:** Střední
- ✅ `getTokenPriceAtDate` už existuje
- ⚠️ Potřeba 2 API volání na Birdeye pro každý swap
- ⚠️ Rate limiting (1-15 rps podle tieru)
- ⚠️ Možná pomalé, pokud je hodně swapů

### 2. Upravit `LotMatchingService` (střední náročnost)

**Soubor:** `apps/backend/src/services/lot-matching.service.ts`

**Změny:**
- Přidat podporu pro `baseToken: 'USD'`
- Upravit FIFO matching, aby fungoval s USD hodnotami
- Možná vytvořit "virtual" base token pro výpočty

**Kód:**
```typescript
// Místo:
const STABLE_BASES = new Set(['SOL', 'WSOL', 'USDC', 'USDT']);

// Přidat:
const STABLE_BASES = new Set(['SOL', 'WSOL', 'USDC', 'USDT', 'USD']);

// V processTradesForToken:
const baseToken = ((trade as any).meta?.baseToken || 'SOL').toUpperCase();
if (!STABLE_BASES.has(baseToken)) {
  continue; // Přeskoč, pokud není base token ani USD
}

// Pro USD base tokeny, použij valueUsd místo amountBase
const amountBase = baseToken === 'USD' 
  ? Number(trade.valueUsd || 0)
  : Number(trade.amountBase || 0);
```

**Náročnost:** Střední
- ✅ Logika je podobná jako pro SOL/USDC/USDT
- ⚠️ Potřeba otestovat FIFO matching s USD hodnotami
- ⚠️ Možná potřeba upravit výpočty PnL

### 3. Batch fetching cen (vysoká náročnost - optimalizace)

**Pro snížení API volání:**
- Seskupit všechny token-to-token swapy
- Získat ceny pro všechny unikátní tokeny najednou (pokud API podporuje batch)
- Nebo použít paralelní fetching s rate limiting

**Náročnost:** Vysoká
- ⚠️ Birdeye API nemá batch endpoint pro historické ceny
- ⚠️ Potřeba implementovat paralelní fetching s rate limiting
- ⚠️ Možná pomalé pro velké množství swapů

## Odhad náročnosti

### Časová náročnost:
- **Základní implementace:** 4-6 hodin
  - Rozšíření `SolanaCollectorService`: 2-3 hodiny
  - Úprava `LotMatchingService`: 1-2 hodiny
  - Testování: 1 hodina

- **Optimalizace (batch fetching):** +2-3 hodiny
  - Paralelní fetching: 1-2 hodiny
  - Rate limiting: 1 hodina

### API náročnost:
- **Pro každý token-to-token swap:** 2 API volání (vstupní + výstupní token)
- **Při 100 swapů/den:** 200 API volání/den
- **Při rate limit 1 rps:** ~200 sekund = ~3.3 minuty
- **Při rate limit 15 rps:** ~13 sekund

### Rizika:
1. **Rate limiting** - Birdeye API má limity (1-15 rps podle tieru)
2. **Chybějící historické ceny** - některé tokeny nemusí mít historické ceny
3. **Pomalé zpracování** - pokud je hodně swapů, může to trvat dlouho
4. **Nesprávné ceny** - pokud je token nový nebo málo obchodovaný, cena může být nepřesná

## Doporučení

### Fáze 1: Základní implementace (doporučeno)
1. Rozšířit `SolanaCollectorService` pro získání cen
2. Upravit `LotMatchingService` pro podporu USD
3. Přidat fallback na `void`, pokud ceny nejsou dostupné
4. **Čas:** 4-6 hodin

### Fáze 2: Optimalizace (volitelné)
1. Batch fetching cen
2. Caching historických cen
3. Paralelní zpracování
4. **Čas:** +2-3 hodiny

## Alternativní řešení

### Možnost 1: Použít pouze jednu stranu swapu
- Místo získání cen obou tokenů, použít pouze cenu výstupního tokenu (pro BUY) nebo vstupního (pro SELL)
- **Výhoda:** Poloviční API volání
- **Nevýhoda:** Méně přesné hodnoty

### Možnost 2: Použít SOL jako proxy
- Převést hodnotu token-to-token swapu na SOL ekvivalent (pomocí ceny SOL v době swapu)
- **Výhoda:** Jednodušší implementace
- **Nevýhoda:** Méně přesné než přímý USD výpočet

### Možnost 3: Použít DexScreener API
- DexScreener má free tier bez API key
- **Výhoda:** Žádné API limity
- **Nevýhoda:** Nemá historické ceny, pouze aktuální

## Závěr

Implementace je **středně náročná** a vyžaduje:
- ✅ Rozšíření existujících služeb
- ⚠️ API volání na Birdeye (rate limits)
- ⚠️ Testování a optimalizace

**Doporučení:** Začít s Fází 1 (základní implementace) a podle potřeby přidat optimalizace.

