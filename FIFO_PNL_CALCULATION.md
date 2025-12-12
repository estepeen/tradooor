# FIFO PnL Calculation - Jak funguje výpočet PnL a Closed Positions

## Přehled

Systém používá **FIFO (First-In-First-Out)** metodu pro párování buy/sell trades a výpočet PnL, stejně jako Kolscan a další profesionální trading platformy.

## Jak funguje FIFO

### 1. FIFO Párování (LotMatchingService)

Pro každý token se udržuje **fronta otevřených lots** (BUY trades):

```
Token: BONK
Open Lots Queue:
  [BUY 1000 @ $0.01]  ← nejstarší (First In)
  [BUY 2000 @ $0.02]
  [BUY 500 @ $0.015]  ← nejnovější
```

Když přijde **SELL trade**, páruje se s **nejstarším BUY trade** (FIFO):

```
SELL 1500 BONK @ $0.025
  ↓
Párování:
  - 1000 z prvního BUY (1000 @ $0.01) → ClosedLot #1
  - 500 z druhého BUY (500 z 2000 @ $0.02) → ClosedLot #2
  
Zbývá v queue:
  [BUY 1500 @ $0.02]  (zbývá z druhého BUY)
  [BUY 500 @ $0.015]
```

### 2. ClosedLot Záznamy

Každý FIFO párovaný lot se uloží jako **ClosedLot** v databázi:

```typescript
{
  walletId: "...",
  tokenId: "...",
  size: 1000,                    // Množství tokenů
  entryPrice: 0.01,              // Cena nákupu (z BUY trade)
  exitPrice: 0.025,              // Cena prodeje (z SELL trade)
  entryTime: "2024-01-01T10:00", // Čas BUY trade
  exitTime: "2024-01-02T15:00",  // Čas SELL trade
  holdTimeMinutes: 1500,         // Doba držení
  costBasis: 10,                 // Náklady (size * entryPrice)
  proceeds: 25,                  // Výnosy (size * exitPrice)
  realizedPnl: 15,              // Zisk/ztráta (proceeds - costBasis)
  realizedPnlPercent: 150,       // ROI % ((realizedPnl / costBasis) * 100)
  buyTradeId: "trade_123",       // ID BUY trade
  sellTradeId: "trade_456",      // ID SELL trade
  sequenceNumber: 1              // Kolikátý BUY-SELL cyklus pro tento token
}
```

### 3. Sequence Number

`sequenceNumber` označuje **kolikátý BUY-SELL cyklus** pro daný token:

- **1.** = první cyklus (první BUY → první SELL, který uzavře pozici)
- **2.** = druhý cyklus (další BUY → další SELL)
- atd.

Příklad:
```
Token: BONK
1. BUY 1000 → SELL 1000 (sequenceNumber: 1) ✅ pozice uzavřena
2. BUY 2000 → SELL 2000 (sequenceNumber: 2) ✅ pozice uzavřena
3. BUY 500 → (otevřená pozice, ještě neuzavřena)
```

## Výpočet PnL

### Důležitý princip: **PnL se počítá POUZE z ClosedLot**

Všechny výpočty PnL v systému používají **ClosedLot** z databáze:

1. **Homepage (recentPnl30d)**:
   ```typescript
   // Filtruj ClosedLot podle exitTime (kdy byl lot uzavřen)
   const recentClosedLots30d = closedLots.filter(lot => {
     const exitTime = new Date(lot.exitTime);
     return exitTime >= thirtyDaysAgo && exitTime <= now;
   });
   
   // Sčítáme realizedPnl z ClosedLot
   const totalPnl30d = recentClosedLots30d.reduce((sum, lot) => 
     sum + lot.realizedPnl, 0
   );
   ```

2. **Detail walletu (portfolio endpoint)**:
   ```typescript
   // Stejná logika jako homepage
   const totalPnl30d = recentClosedLots30d.reduce((sum, lot) => 
     sum + lot.realizedPnl, 0
   );
   ```

3. **Metrics Calculator (rolling stats)**:
   ```typescript
   // computeRollingStatsAndScores používá ClosedLot
   const rolling30d = {
     realizedPnl: closedLots30d.reduce((sum, lot) => sum + lot.realizedPnl, 0),
     numClosedTrades: closedLots30d.length,
     // ...
   };
   ```

### Proč POUZE z ClosedLot?

- ✅ **Jednotný princip** - všechny výpočty používají stejný zdroj dat
- ✅ **Přesnost** - FIFO párování zajišťuje správné náklady a výnosy
- ✅ **Konzistence** - homepage a detail stránka mají stejné hodnoty
- ✅ **Auditovatelnost** - každý ClosedLot je v databázi a lze ho ověřit

## Closed Positions v UI

### Seskupení podle sellTradeId

V UI se ClosedLot **seskupují podle `sellTradeId`**:

```typescript
// Jeden SELL trade může uzavřít více BUY trades (FIFO)
const lotsBySellTradeId = new Map();
for (const lot of closedLots) {
  const sellTradeId = lot.sellTradeId;
  if (!lotsBySellTradeId.has(sellTradeId)) {
    lotsBySellTradeId.set(sellTradeId, []);
  }
  lotsBySellTradeId.get(sellTradeId).push(lot);
}

// Pro každou skupinu vytvoříme jednu closed position
for (const [sellTradeId, lots] of lotsBySellTradeId) {
  const closedPosition = {
    tokenId: lots[0].tokenId,
    sequenceNumber: lots[0].sequenceNumber,
    realizedPnlBase: lots.reduce((sum, lot) => sum + lot.realizedPnl, 0),
    buyCount: lots.length,  // Počet BUY trades, které byly uzavřeny
    sellCount: 1,           // Jeden SELL trade
    // ...
  };
}
```

**Proč seskupování?**
- Jeden SELL trade = jedna "uzavřená pozice" v UI
- Uživatel vidí, kolik BUY trades bylo uzavřeno jedním SELL trade
- PnL je součet všech ClosedLot pro daný SELL trade

### Alternativa: Zobrazit každý ClosedLot samostatně

Pokud bychom chtěli zobrazit každý ClosedLot jako samostatnou closed position:

```typescript
// Každý ClosedLot = jedna closed position
const closedPositions = closedLots.map(lot => ({
  tokenId: lot.tokenId,
  sequenceNumber: lot.sequenceNumber,
  realizedPnlBase: lot.realizedPnl,
  size: lot.size,
  entryPrice: lot.entryPrice,
  exitPrice: lot.exitPrice,
  // ...
}));
```

**Výhody:**
- ✅ Přesnější zobrazení (každý FIFO párovaný lot je vidět)
- ✅ Jednodušší logika (žádné seskupování)

**Nevýhody:**
- ❌ Více řádků v UI (jeden SELL může vytvořit více closed positions)
- ❌ Může být matoucí pro uživatele

## Konzistence napříč webem

### Zásady:

1. **Všechny výpočty PnL používají ClosedLot** ✅
   - Homepage: `rolling30d.realizedPnl` z ClosedLot
   - Detail: `totalPnl30d` z ClosedLot
   - Metrics: `computeRollingStatsAndScores` z ClosedLot

2. **Filtrování podle exitTime** ✅
   - 30d PnL = ClosedLot s `exitTime >= thirtyDaysAgo && exitTime <= now`
   - Stejné filtrování všude

3. **Closed Positions v UI** ✅
   - Vytváří se z ClosedLot
   - Seskupené podle `sellTradeId` (jeden SELL = jedna pozice)
   - Nebo každý ClosedLot samostatně (podle preference)

## Příklad: Jak to funguje v praxi

```
Wallet: Trader X
Token: BONK

Trades:
1. BUY 1000 BONK @ $0.01 (2024-01-01 10:00)
2. BUY 2000 BONK @ $0.02 (2024-01-01 11:00)
3. SELL 1500 BONK @ $0.025 (2024-01-02 15:00)

FIFO Párování:
- SELL 1500 páruje s:
  - 1000 z BUY #1 → ClosedLot #1 (realizedPnl: 15)
  - 500 z BUY #2 → ClosedLot #2 (realizedPnl: 2.5)

ClosedLot v databázi:
1. { size: 1000, entryPrice: 0.01, exitPrice: 0.025, realizedPnl: 15, ... }
2. { size: 500, entryPrice: 0.02, exitPrice: 0.025, realizedPnl: 2.5, ... }

Closed Positions v UI:
- 1 pozice (seskupená podle sellTradeId):
  - Token: BONK
  - Size: 1500
  - PnL: 17.5 (15 + 2.5)
  - Buy Count: 2 (dva BUY trades byly uzavřeny)
  - Sell Count: 1 (jeden SELL trade)

PnL výpočet:
- 30d PnL = 17.5 (suma realizedPnl z ClosedLot #1 a #2)
```

## Závěr

Systém používá **FIFO metodu** pro párování trades a výpočet PnL, stejně jako Kolscan:

1. ✅ **FIFO párování** - SELL se páruje s nejstarším BUY
2. ✅ **ClosedLot záznamy** - každý párovaný lot je v databázi
3. ✅ **Konzistentní PnL** - všechny výpočty používají ClosedLot
4. ✅ **Closed Positions** - zobrazují se z ClosedLot (seskupené nebo samostatně)

**Důležité:** PnL se **NIKDY** nepočítá přímo z trades, vždy z ClosedLot (FIFO párované).
