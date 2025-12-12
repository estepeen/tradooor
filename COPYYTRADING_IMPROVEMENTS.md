# Vylepšení Closed Positions a Metriky pro Copytrading Bota

## 1. Jak počítat Closed Positions (aktuální stav + vylepšení)

### ✅ Současný stav (FIFO metoda)
- **FIFO párování** - SELL se páruje s nejstarším BUY
- **ClosedLot záznamy** - každý párovaný lot je v databázi
- **Sequence Number** - sledování více cyklů pro stejný token (1., 2., 3. atd.)
- **Hold Time** - přesný čas od entry do exit
- **Realized PnL** - v SOL/base měně (konzistentní napříč systémem)

### 🚀 Navrhovaná vylepšení

#### 1.1. Sledování Partial Exits (částečné výstupy)
**Problém:** Pokud trader prodá 50% pozice, pak dalších 30%, pak zbytek - každý partial exit by měl být samostatný closed position.

**Řešení:**
- Už implementováno přes FIFO - každý SELL vytváří ClosedLot
- **Vylepšení:** Seskupit ClosedLots podle `sellTradeId` pro UI (jeden SELL může uzavřít více BUY)
- **Přidat:** `partialExitSequence` - kolikátý partial exit v rámci jedné pozice (1., 2., 3.)

#### 1.2. Sledování DCA (Dollar Cost Averaging)
**Problém:** Pokud trader koupí token 3x před prodejem, měli bychom sledovat:
- Průměrnou entry cenu
- Počet DCA vstupů
- Čas mezi DCA vstupy

**Řešení:**
- Už implementováno - FIFO správně páruje více BUY s jedním SELL
- **Přidat do ClosedLot:**
  ```typescript
  dcaEntryCount: number; // Kolik BUY trades tvoří tento closed lot
  avgEntryPrice: number; // Průměrná entry cena (už máme přes FIFO)
  dcaTimeSpanMinutes: number; // Čas od prvního BUY do posledního BUY před SELL
  ```

#### 1.3. Sledování Re-entry Patterns
**Problém:** Pokud trader prodá token a pak ho koupí znovu, měli bychom sledovat:
- Čas mezi exit a re-entry
- Důvod re-entry (cena klesla? vzrostla?)
- Úspěšnost re-entry (byl druhý cyklus lepší než první?)

**Řešení:**
- Už máme `sequenceNumber` - sleduje více cyklů
- **Přidat do ClosedLot:**
  ```typescript
  reentryTimeMinutes: number | null; // Čas od předchozího exit do tohoto entry (null pro první cyklus)
  reentryPriceChangePercent: number | null; // Změna ceny od předchozího exit
  previousCyclePnl: number | null; // PnL předchozího cyklu (pro srovnání)
  ```

#### 1.4. Sledování Stop-Loss a Take-Profit
**Problém:** Nevíme, jestli trader použil stop-loss nebo take-profit.

**Řešení:**
- **Přidat do ClosedLot:**
  ```typescript
  exitReason: 'take_profit' | 'stop_loss' | 'manual' | 'unknown';
  maxProfitPercent: number; // Maximální zisk během držení pozice
  maxDrawdownPercent: number; // Maximální ztráta během držení pozice
  timeToMaxProfitMinutes: number; // Jak rychle dosáhl max zisku
  ```

#### 1.5. Sledování Market Conditions při Entry/Exit
**Problém:** Nevíme, jaké byly tržní podmínky při vstupu/výstupu.

**Řešení:**
- **Přidat do ClosedLot:**
  ```typescript
  entryMarketCap: number | null; // Market cap tokenu při entry
  exitMarketCap: number | null; // Market cap tokenu při exit
  entryLiquidity: number | null; // Liquidity při entry
  exitLiquidity: number | null; // Liquidity při exit
  entryVolume24h: number | null; // 24h volume při entry
  exitVolume24h: number | null; // 24h volume při exit
  tokenAgeAtEntryMinutes: number | null; // Stáří tokenu při entry
  ```

---

## 2. Nové typy obchodů k sledování

### 2.1. Sledování Limit Orders
**Problém:** Pokud trader použije limit order, měli bychom to vědět.

**Řešení:**
- **Přidat do Trade:**
  ```typescript
  orderType: 'market' | 'limit' | 'unknown';
  limitPrice: number | null; // Cena limit orderu (pokud je limit)
  filledPrice: number; // Skutečná cena, za kterou byl order vyplněn
  slippagePercent: number | null; // Slippage (rozdíl mezi limit a filled)
  ```

### 2.2. Sledování Sniper Trades (velmi rychlé vstupy)
**Problém:** Pokud trader vstoupí do tokenu velmi rychle po launch, měli bychom to sledovat.

**Řešení:**
- **Přidat do TradeFeature:**
  ```typescript
  isSniperTrade: boolean; // Entry do tokenu < 5 minut po launch
  tokenAgeAtEntrySeconds: number; // Stáří tokenu při entry
  launchToEntrySeconds: number; // Čas od launch do entry
  ```

### 2.3. Sledování Scalping Patterns
**Problém:** Pokud trader dělá velmi rychlé obchody (scalping), měli bychom to vědět.

**Řešení:**
- **Přidat do ClosedLot:**
  ```typescript
  isScalp: boolean; // Hold time < 5 minut
  scalpProfitability: number; // Průměrný zisk z scalp trades
  ```

### 2.4. Sledování Swing Trades
**Problém:** Pokud trader drží pozice dlouho (swing trading), měli bychom to vědět.

**Řešení:**
- **Přidat do ClosedLot:**
  ```typescript
  isSwing: boolean; // Hold time > 24 hodin
  swingProfitability: number; // Průměrný zisk z swing trades
  ```

### 2.5. Sledování Position Sizing Patterns
**Problém:** Nevíme, jestli trader mění velikost pozic podle podmínek.

**Řešení:**
- **Přidat do TradeSequence:**
  ```typescript
  positionSizeUsd: number; // Velikost pozice v USD
  positionSizePercent: number; // Velikost pozice jako % portfolia
  positionSizeChangeVsPrevious: number; // Změna vs. předchozí trade
  ```

---

## 3. Metriky pro Copytrading Bota

### 3.1. Entry Timing Metriky
**Proč:** Bot potřebuje vědět, kdy nejlépe vstoupit.

**Metriky:**
- `avgTimeToEntryAfterSignalMinutes` - Průměrný čas od signálu (např. Twitter post) do entry
- `bestEntryTimeOfDay` - Nejlepší čas dne pro entry (hodina s nejlepším win rate)
- `bestEntryDayOfWeek` - Nejlepší den v týdnu pro entry
- `entrySuccessRateByTokenAge` - Win rate podle stáří tokenu (nový vs. starý)

### 3.2. Exit Timing Metriky
**Proč:** Bot potřebuje vědět, kdy nejlépe vystoupit.

**Metriky:**
- `avgHoldTimeWinners` - Průměrná doba držení pro ziskové trades
- `avgHoldTimeLosers` - Průměrná doba držení pro ztrátové trades
- `optimalExitTimePercentile` - Percentil, kdy trader nejčastěji vystupuje (např. 75% = vystupuje když je na 75% max zisku)
- `exitSuccessRateByProfitPercent` - Win rate podle % zisku při exit

### 3.3. Risk Management Metriky
**Proč:** Bot potřebuje vědět, jak trader řídí riziko.

**Metriky:**
- `avgRiskRewardRatio` - Průměrný risk/reward poměr (už máme `avgRr`)
- `maxPositionSizeUsd` - Maximální velikost pozice
- `avgPositionSizePercent` - Průměrná velikost pozice jako % portfolia
- `stopLossUsageRate` - Kolik % trades má stop-loss
- `takeProfitUsageRate` - Kolik % trades má take-profit
- `avgStopLossPercent` - Průměrný stop-loss v %
- `avgTakeProfitPercent` - Průměrný take-profit v %

### 3.4. Token Selection Metriky
**Proč:** Bot potřebuje vědět, jaké tokeny trader preferuje.

**Metriky:**
- `preferredTokenAgeRange` - Preferované stáří tokenů (nové vs. staré)
- `preferredMarketCapRange` - Preferovaný rozsah market cap
- `preferredLiquidityRange` - Preferovaný rozsah liquidity
- `tokenDiversityScore` - Jak diverzifikovaný je trader (kolik různých tokenů)
- `avgTokensPerDay` - Průměrný počet různých tokenů za den

### 3.5. Market Condition Metriky
**Proč:** Bot potřebuje vědět, za jakých podmínek trader nejlépe obchoduje.

**Metriky:**
- `winRateByMarketCondition` - Win rate podle tržních podmínek (bull/bear/sideways)
- `bestPerformingMarketCondition` - Nejlepší tržní podmínky pro tradera
- `avgPnlByVolatility` - Průměrný PnL podle volatility trhu
- `correlationWithSolPrice` - Korelace s cenou SOL (obchoduje proti trendu nebo s trendem?)

### 3.6. Pattern Recognition Metriky
**Proč:** Bot potřebuje rozpoznat opakující se vzory.

**Metriky:**
- `dcaSuccessRate` - Win rate při použití DCA
- `reentrySuccessRate` - Win rate při re-entry do tokenu
- `scalpSuccessRate` - Win rate při scalping
- `swingSuccessRate` - Win rate při swing trading
- `sniperSuccessRate` - Win rate při sniper trades

### 3.7. Performance Consistency Metriky
**Proč:** Bot potřebuje vědět, jestli je trader konzistentní.

**Metriky:**
- `winStreakAvg` - Průměrná délka win streak
- `lossStreakAvg` - Průměrná délka loss streak
- `consistencyScore` - Skóre konzistence (už máme v `consistencyScore`)
- `volatilityOfReturns` - Volatilita výnosů (už máme v `volatilityPercent`)
- `sharpeRatio` - Sharpe ratio (risk-adjusted returns)

---

## 4. Podmínky pro Copytrading Bota

### 4.1. Základní filtry
```typescript
interface CopyTradingConditions {
  // Minimální požadavky
  minScore: number; // Minimální score (např. 70)
  minTotalTrades: number; // Minimální počet trades (např. 50)
  minWinRate: number; // Minimální win rate (např. 0.55 = 55%)
  minRecentPnl30dPercent: number; // Minimální PnL za 30d (např. 10%)
  
  // Risk management
  maxDrawdownPercent: number; // Maximální drawdown (např. 30%)
  maxPositionSizeUsd: number; // Maximální velikost pozice (např. 1000 USD)
  maxDailyLossPercent: number; // Maximální denní ztráta (např. 5%)
  
  // Token selection
  preferredTokenAgeRange: [number, number]; // [min, max] v minutách
  preferredMarketCapRange: [number, number]; // [min, max] v USD
  preferredLiquidityRange: [number, number]; // [min, max] v USD
  
  // Timing
  preferredEntryTimeOfDay: [number, number]; // [start hour, end hour]
  preferredDaysOfWeek: number[]; // [0=Sunday, 1=Monday, ...]
  
  // Pattern matching
  requireDca: boolean; // Vyžadovat DCA?
  requireStopLoss: boolean; // Vyžadovat stop-loss?
  requireTakeProfit: boolean; // Vyžadovat take-profit?
  minScalpSuccessRate: number; // Minimální win rate pro scalping
  minSwingSuccessRate: number; // Minimální win rate pro swing trading
}
```

### 4.2. Dynamické podmínky (podle tržních podmínek)
```typescript
interface DynamicCopyTradingConditions {
  // Adjust podle tržních podmínek
  adjustPositionSizeByVolatility: boolean; // Snížit velikost pozice při vysoké volatilitě
  adjustEntryTimingByMarketCondition: boolean; // Upravit timing podle tržních podmínek
  pauseOnHighDrawdown: boolean; // Pozastavit copytrading při vysokém drawdownu
  pauseOnLossStreak: number; // Pozastavit po X ztrátách v řadě
}
```

### 4.3. Smart Copying (ne kopírovat všechno)
```typescript
interface SmartCopyConditions {
  // Kopírovat pouze:
  copyOnlyWinningPatterns: boolean; // Pouze vzory, které mají vysoký win rate
  copyOnlyPreferredTokens: boolean; // Pouze tokeny, které trader preferuje
  copyOnlyPreferredTiming: boolean; // Pouze v preferovaném čase
  copyOnlyPreferredMarketConditions: boolean; // Pouze za preferovaných tržních podmínek
  
  // Risk management
  skipHighRiskTrades: boolean; // Přeskočit vysokorizikové trades
  skipLowLiquidityTrades: boolean; // Přeskočit trades s nízkou likviditou
  skipNewTokenTrades: boolean; // Přeskočit trades s velmi novými tokeny
}
```

---

## 5. Implementační priority

### Priorita 1 (Kritické pro copytrading)
1. ✅ **FIFO párování** - už implementováno
2. ✅ **Sequence Number** - už implementováno
3. ⚠️ **Entry/Exit Timing Metriky** - přidat
4. ⚠️ **Risk Management Metriky** - přidat
5. ⚠️ **Stop-Loss/Take-Profit detekce** - přidat

### Priorita 2 (Důležité pro kvalitu)
1. ⚠️ **Market Conditions při Entry/Exit** - přidat
2. ⚠️ **Token Selection Metriky** - přidat
3. ⚠️ **Pattern Recognition Metriky** - přidat
4. ⚠️ **DCA tracking** - vylepšit

### Priorita 3 (Nice to have)
1. ⚠️ **Limit Orders tracking** - přidat
2. ⚠️ **Sniper Trades tracking** - přidat
3. ⚠️ **Re-entry Patterns** - vylepšit
4. ⚠️ **Position Sizing Patterns** - vylepšit

---

## 6. Doporučení

### 6.1. Pro Closed Positions
- **Zachovat FIFO metodu** - je to správně a konzistentní
- **Přidat více kontextu** - market conditions, token metadata při entry/exit
- **Sledovat partial exits** - už funguje, jen vylepšit UI zobrazení
- **Sledovat DCA** - už funguje přes FIFO, jen přidat metriky

### 6.2. Pro Copytrading Bota
- **Začít s jednoduchými podmínkami** - score, win rate, recent PnL
- **Postupně přidávat složitější podmínky** - market conditions, timing, patterns
- **Sledovat performance** - jak se botu daří s různými podmínkami
- **A/B testovat** - zkoušet různé kombinace podmínek

### 6.3. Pro Metriky
- **Fokus na actionable metriky** - ty, které bot může použít pro rozhodování
- **Sledovat konzistenci** - nejen průměrné hodnoty, ale i volatilitu
- **Sledovat trendy** - jak se trader vyvíjí v čase
- **Sledovat podmínky** - za jakých podmínek trader nejlépe obchoduje

---

## 7. Příklady použití

### 7.1. Jednoduchý copytrading bot
```typescript
// Kopírovat všechny trades od tradera s:
// - score > 70
// - win rate > 55%
// - recent PnL 30d > 10%
const conditions = {
  minScore: 70,
  minWinRate: 0.55,
  minRecentPnl30dPercent: 10,
};
```

### 7.2. Pokročilý copytrading bot
```typescript
// Kopírovat pouze:
// - Scalping trades (hold time < 5 min) s win rate > 60%
// - V preferovaném čase (9-17h)
// - S stop-loss
// - S liquidity > 50k USD
const conditions = {
  minScore: 70,
  minWinRate: 0.55,
  minRecentPnl30dPercent: 10,
  copyOnlyScalping: true,
  minScalpSuccessRate: 0.60,
  preferredEntryTimeOfDay: [9, 17],
  requireStopLoss: true,
  preferredLiquidityRange: [50000, Infinity],
};
```

### 7.3. Adaptivní copytrading bot
```typescript
// Dynamicky upravovat podle:
// - Tržních podmínek (bull/bear)
// - Volatility
// - Drawdownu
const conditions = {
  minScore: 70,
  minWinRate: 0.55,
  adjustPositionSizeByVolatility: true,
  pauseOnHighDrawdown: true,
  copyOnlyPreferredMarketConditions: true,
};
```

---

## Závěr

Současný systém FIFO párování je **správný a konzistentní**. Pro copytrading bota bychom měli:

1. **Přidat více kontextu** do ClosedLot (market conditions, token metadata)
2. **Sledovat nové metriky** (timing, risk management, patterns)
3. **Implementovat podmínky** pro copytrading (filtry, dynamické úpravy)
4. **Sledovat performance** bota a iterovat

Nejdůležitější je začít **jednoduše** a postupně přidávat složitější funkce podle potřeby.
