# Datový tok - SolBot

## Přehled

Tento dokument popisuje datový tok v SolBot projektu - jak se data sbírají, zpracovávají a ukládají.

## 1. Helius Webhook (Realtime ingest)

### Účel
Helius nám pushuje nové swapy pro sledované walletky – žádné periodické pollování ani backfill skripty.

### Datový tok

```
1. Helius webhook → POST /api/webhooks/helius
   ↓
2. Router okamžitě odpoví 200 OK a předá payload do backgroundu
   ↓
3. `processHeliusWebhook` spáruje transakce s našimi smart wallets
   ↓
4. `SolanaCollectorService.processWebhookTransaction`
   - Normalizuje swap (Helius Enhanced API)
   - Obohatí token metadata + ceny
   - Určí typ obchodu (buy/add/remove/sell) + PnL
   - Uloží trade do DB a přepočítá metriky
```

### Implementace

- **Router:** `apps/backend/src/routes/webhooks.ts`
- **Service:** `SolanaCollectorService` (`apps/backend/src/services/solana-collector.service.ts`)
- **Setup:** `POST /api/webhooks/setup` nahraje všechny wallet adresy do jednoho Helius webhooku

### Poznámky

- Webhooky jsou jediný zdroj pravdy – historické backfilly byly odstraněny, aby se předešlo runaway nákladům.
- Každý trade nese `meta.source = helius-webhook`, takže je jasné odkud data přišla.

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
2. (Jednorázově) POST /api/webhooks/setup → registrace adres u Heliusu
   ↓
3. Helius posílá webhook na každý nový swap
   ↓
4. Backend uloží trade + přepočítá metriky
   ↓
5. Frontend načte data přes API
```

### Manuální workflow

```bash
# 1. Přidat wallet
curl -X POST http://localhost:3001/api/smart-wallets \
  -H "Content-Type: application/json" \
  -d '{"address": "WALLET_ADDRESS", "label": "My Trader"}'

# 2. Nastavit/refreshnout webhook
curl -X POST http://localhost:3001/api/webhooks/setup

# 3. Hotovo – čekej na webhooky, žádné backfilly nejsou potřeba
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

### Helius Webhook
- [ ] Alerting, pokud webhook nepřijde X minut
- [ ] Persist webhook delivery IDs pro audit

### Metrics Calculator
- [ ] Vylepšit score formula
- [ ] Přidat více metrik (Sharpe ratio, profit factor, atd.)
- [ ] Optimalizace výpočtů pro velké množství tradeů
- [ ] Caching pro rychlejší přepočty

### Automatizace
- [ ] Queue systém pro zpracování transakcí
- [ ] Monitoring a alerting
- [ ] Automatické restartování při chybách

