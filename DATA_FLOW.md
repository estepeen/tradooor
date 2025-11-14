# Datový tok - SolBot

## Přehled

Tento dokument popisuje datový tok v SolBot projektu - jak se data sbírají, zpracovávají a ukládají.

## 1. Solana Collector (Sběr dat)

### Účel
Sleduje on-chain transakce pro tracked smart wallets a ukládá swapy do databáze.

### Datový tok

```
1. Načte seznam sledovaných adres z databáze (smart_wallets.address)
   ↓
2. Napojí se na Solana RPC/WebSocket
   ↓
3. Poslouchá odchozí/incoming transakce pro tyto adresy
   ↓
4. Detekuje swapy/DEX interakce
   ↓
5. Parsuje transakci a extrahuje:
   - Token address (mint)
   - Side (buy/sell)
   - Amount (token + base)
   - Price per token
   - DEX identifier
   ↓
6. Uloží záznam do trades tabulky
```

### Implementace

**Service:** `SolanaCollectorService` (`apps/backend/src/services/solana-collector.service.ts`)

**Worker script:** `apps/backend/src/workers/solana-collector.ts`

**Použití:**
```bash
# Spustit collector
pnpm --filter backend collector:start

# Backfill historických dat
pnpm --filter backend collector:backfill WALLET_ADDRESS [LIMIT]
```

### TODO / Co je potřeba implementovat

1. **Parsování transakcí:**
   - Identifikace DEXu z program ID
   - Extrakce swap dat z instructions
   - Detekce buy vs sell
   - Výpočet ceny per token

2. **Podporované DEXy:**
   - Jupiter
   - Raydium
   - Pump.fun
   - Orca
   - (další podle potřeby)

3. **Optimalizace:**
   - WebSocket subscription místo polling
   - Batch processing
   - Rate limiting handling

## 2. Metrics Calculator (Přepočet metrik)

### Účel
Přepočítává metriky pro každou walletku na základě jejich tradeů.

### Datový tok

```
1. Projde všechny trades dané walletky
   ↓
2. Sestaví pozice (párování buy/sell u stejného tokenu)
   ↓
3. Spočítá metriky:
   - Win rate (procento ziskových pozic)
   - Průměrné PnL v %
   - Celkový PnL
   - Průměrnou dobu držení (na základě párování buy/sell)
   - Max drawdown
   - Score (kombinace recent PnL, winrate a počtu tradeů)
   ↓
4. Uloží aktuální hodnoty do smart_wallets tabulky
   ↓
5. Vytvoří nový záznam do smart_wallet_metrics_history
```

### Implementace

**Service:** `MetricsCalculatorService` (`apps/backend/src/services/metrics-calculator.service.ts`)

**Worker script:** `apps/backend/src/workers/calculate-metrics.ts`

**Cron job:** `apps/backend/src/workers/metrics-cron.ts`

**Použití:**
```bash
# Jednorázový přepočet
pnpm --filter backend calculate-metrics [WALLET_ID]

# Periodický cron job (každých 6 hodin)
pnpm --filter backend metrics:cron

# Vlastní schedule přes env var
CRON_SCHEDULE="0 */6 * * *" pnpm --filter backend metrics:cron
```

### Metriky

1. **Win Rate** - Procento ziskových pozic (0-1)
2. **Average PnL %** - Průměrné procento zisku/ztráty na trade
3. **Total PnL** - Celkový zisk/ztráta v base měně
4. **Average Holding Time** - Průměrná doba držení pozice v minutách
5. **Max Drawdown** - Maximální pokles z vrcholu
6. **Recent PnL (30d)** - Celkový PnL za posledních 30 dní
7. **Score** - Celkové skóre kvality tradera (0-100)
   - Kombinace: win rate, avg PnL %, recent PnL, volume

### Score Formula

```
score = (winRate * 30) + 
        (min(avgPnlPercent / 2, 30)) + 
        (min(recentPnl30dPercent / 2, 30)) + 
        (min(totalTrades / 10, 10))
```

Maximálně 100 bodů.

## 3. Workflow

### Kompletní workflow

```
1. Přidání wallet do systému
   POST /api/smart-wallets
   ↓
2. Solana Collector začne sledovat transakce
   collector:start
   ↓
3. Detekce swapů a uložení do trades
   (automaticky při nových transakcích)
   ↓
4. Periodický přepočet metrik
   metrics:cron (každých 6 hodin)
   ↓
5. Zobrazení v dashboardu
   Frontend načte data přes API
```

### Manuální workflow

```bash
# 1. Přidat wallet
curl -X POST http://localhost:3001/api/smart-wallets \
  -H "Content-Type: application/json" \
  -d '{"address": "WALLET_ADDRESS", "label": "My Trader"}'

# 2. Backfill historických dat (volitelné)
pnpm --filter backend collector:backfill WALLET_ADDRESS 100

# 3. Přepočítat metriky
pnpm --filter backend calculate-metrics

# 4. Zobrazit v dashboardu
# Otevři http://localhost:3000/wallets
```

## 4. Struktura dat

### Trades → Positions

Trades se párují do pozic:
- **Buy trade** → otevře pozici
- **Sell trade** → uzavře pozici (nebo částečně)

Pozice se počítají per token - pokud trader koupí stejný token vícekrát, pozice se průměrují.

### Metrics History

Každý přepočet metrik vytvoří nový záznam v `smart_wallet_metrics_history`, což umožňuje:
- Grafy vývoje metrik v čase
- Analýzu trendů
- Sledování změn výkonnosti

## 5. TODO / Budoucí vylepšení

### Solana Collector
- [ ] Implementovat parsování pro Jupiter
- [ ] Implementovat parsování pro Raydium
- [ ] Implementovat parsování pro Pump.fun
- [ ] WebSocket subscription místo polling
- [ ] Batch processing pro efektivitu
- [ ] Error handling a retry logic

### Metrics Calculator
- [ ] Vylepšit score formula
- [ ] Přidat více metrik (Sharpe ratio, profit factor, atd.)
- [ ] Optimalizace výpočtů pro velké množství tradeů
- [ ] Caching pro rychlejší přepočty

### Automatizace
- [ ] Queue systém pro zpracování transakcí
- [ ] Monitoring a alerting
- [ ] Automatické restartování při chybách

