# Token-to-Token Swaps - Návrh implementace

## Aktuální stav

Token-to-token swapy (shitcoin → shitcoin) se aktuálně:
- Detekují v `SolanaCollectorService`
- Označují jako `side: 'void'` a `baseToken: 'VOID'`
- Přeskočí se v `LotMatchingService` (nejsou zahrnuty do closed lots)
- Zobrazují se v "Recent Trades" jako fialové "VOID" trades

## Co by bylo potřeba pro zpracování

### 1. Detekce token-to-token swapů
✅ **Už implementováno** - swapy se detekují v `normalizeQuickNodeSwap` a `normalizeHeliusSwap`

### 2. Výpočet hodnoty v USD
**Potřeba implementovat:**
- Získat cenu vstupního tokenu v době swapu (z Birdeye API)
- Získat cenu výstupního tokenu v době swapu
- Vypočítat hodnotu swapu v USD:
  - `valueUsd = (amountIn * priceInUsd) + (amountOut * priceOutUsd) / 2`
  - Nebo použít pouze jednu stranu: `valueUsd = amountIn * priceInUsd`

### 3. Úprava lot matching logiky
**Potřeba implementovat:**
- Místo base tokenu (SOL/USDC/USDT) použít USD jako společnou měnu
- Pro token-to-token swapy:
  - BUY = získání nového tokenu (hodnota v USD z ceny výstupního tokenu)
  - SELL = prodej starého tokenu (hodnota v USD z ceny vstupního tokenu)
- Upravit FIFO matching, aby fungoval s USD hodnotami místo base tokenů

### 4. Úprava databázového schématu
**Možná potřeba:**
- Přidat `baseToken: 'USD'` pro token-to-token swapy
- Nebo použít `baseToken: 'VOID'` ale s vypočítanou `valueUsd`

## Implementační kroky

### Krok 1: Rozšířit `SolanaCollectorService`
- Při detekci token-to-token swapu:
  1. Získat cenu vstupního tokenu z Birdeye API (historická cena v době swapu)
  2. Získat cenu výstupního tokenu z Birdeye API
  3. Vypočítat `valueUsd` a `priceBasePerToken`
  4. Nastavit `baseToken: 'USD'` místo `'VOID'`

### Krok 2: Upravit `LotMatchingService`
- Přidat podporu pro `baseToken: 'USD'`
- Upravit FIFO matching, aby fungoval s USD hodnotami
- Možná vytvořit "virtual" base token pro výpočty

### Krok 3: Úprava výpočtů PnL
- PnL pro token-to-token swapy se počítá v USD
- Win rate a další metriky zůstávají stejné

## Náročnost

### Nízká náročnost:
- ✅ Detekce token-to-token swapů (už implementováno)
- ✅ Zobrazení v UI (už implementováno jako VOID)

### Střední náročnost:
- ⚠️ Získání historických cen z Birdeye API (může být pomalé, rate limits)
- ⚠️ Úprava lot matching logiky pro USD hodnoty

### Vysoká náročnost:
- ⚠️ Batch fetching historických cen (pro optimalizaci)
- ⚠️ Caching historických cen (pro snížení API volání)
- ⚠️ Fallback mechanismy, pokud cena není dostupná

## Odhad API volání

Pokud máme 100 token-to-token swapů denně:
- 200 API volání na Birdeye (2 tokeny × 100 swapů)
- Při rate limit 1 rps = ~200 sekund = ~3.3 minuty
- Při rate limit 15 rps = ~13 sekund

## Doporučení

1. **Fáze 1: Základní implementace**
   - Získat ceny pro token-to-token swapy z Birdeye API
   - Vypočítat `valueUsd` a `priceBasePerToken`
   - Nastavit `baseToken: 'USD'` místo `'VOID'`

2. **Fáze 2: Optimalizace**
   - Batch fetching cen
   - Caching historických cen
   - Fallback mechanismy

3. **Fáze 3: Rozšíření**
   - Podpora pro více typů token-to-token swapů
   - Lepší detekce a parsování

## Alternativní řešení

Místo Birdeye API bychom mohli použít:
- **DexScreener API** (free, ale nemá historické ceny)
- **Jupiter API** (má ceny, ale rate limits)
- **Lokální cache** (pokud máme historické ceny v DB)

## Poznámky

- Token-to-token swapy jsou časté u "degen" traderů
- Mohou být důležité pro copytrading analýzu
- Měly by se zobrazovat v closed positions, pokud mají vypočítanou hodnotu
