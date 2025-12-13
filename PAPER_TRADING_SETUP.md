# Paper Trading Setup Guide

## Fáze 1: Základní Paper Trading (Bez AI)

Tento dokument popisuje, jak nastavit a spustit základní paper trading systém, který kopíruje trades z tracked wallets.

## 📋 Požadavky

- Supabase databáze
- Backend běžící na portu 3001
- Frontend běžící na portu 4444

## 🗄️ Database Setup

1. Spusť SQL migraci pro vytvoření tabulek:

```bash
# Připoj se k Supabase a spusť:
psql -h <your-supabase-host> -U postgres -d postgres -f ADD_PAPER_TRADING.sql

# Nebo použij Supabase Dashboard → SQL Editor
```

Tabulky:
- `PaperTrade` - simulované obchody
- `PaperPortfolio` - portfolio snapshots pro tracking

## ⚙️ Konfigurace

Nastav environment variables v `.env`:

```env
# Paper Trading Configuration
PAPER_TRADING_ENABLED=true
PAPER_TRADING_COPY_ALL=true              # Kopírovat všechny trades (true) nebo jen vybrané wallets (false)
PAPER_TRADING_MIN_SCORE=70                # Minimální score wallet pro kopírování (volitelné)
PAPER_TRADING_POSITION_SIZE_PERCENT=5     # % portfolia na trade (default: 5%)
PAPER_TRADING_MAX_POSITION_SIZE_USD=1000  # Max velikost pozice v USD (volitelné)
PAPER_TRADING_MAX_OPEN_POSITIONS=10       # Max počet otevřených pozic najednou
```

## 🚀 Spuštění

### 1. Spusť Backend

```bash
cd apps/backend
pnpm dev
```

### 2. Spusť Paper Trading Monitor Worker

V novém terminálu:

```bash
cd apps/backend
pnpm paper-trading:monitor
```

Worker bude:
- Monitorovat nové BUY trades každých 30 sekund
- Kopírovat je jako paper trades
- Uzavírat paper trades když trader prodá (SELL)
- Vytvářet portfolio snapshots každých 5 minut

### 3. Spusť Frontend

```bash
cd apps/frontend
pnpm dev
```

### 4. Otevři Paper Trading Dashboard

Přejdi na: `http://localhost:4444/paper-trading`

## 📊 API Endpoints

### GET `/api/paper-trading/portfolio`
Získá aktuální portfolio stats:
```json
{
  "success": true,
  "totalValueUsd": 10000.50,
  "totalCostUsd": 9500.00,
  "totalPnlUsd": 500.50,
  "totalPnlPercent": 5.27,
  "openPositions": 5,
  "closedPositions": 10,
  "winRate": 0.6,
  "totalTrades": 15
}
```

### GET `/api/paper-trading/trades`
Získá seznam paper trades:
```
GET /api/paper-trading/trades?walletId=xxx&status=open&limit=100
```

### GET `/api/paper-trading/trades/:id`
Získá detail paper trade

### POST `/api/paper-trading/copy-trade`
Manuálně zkopíruje trade:
```json
{
  "tradeId": "trade_123",
  "config": {
    "positionSizePercent": 5,
    "maxPositionSizeUsd": 1000
  }
}
```

### GET `/api/paper-trading/portfolio/history`
Získá historii portfolio snapshots

## 🎯 Jak to funguje

1. **Signal Detection**: Worker monitoruje nové trades v databázi
2. **Copy BUY**: Když tracked wallet koupí token, vytvoří se paper trade
3. **Close on SELL**: Když tracked wallet prodá token, uzavře se odpovídající paper trade
4. **Portfolio Tracking**: Každých 5 minut se vytvoří portfolio snapshot

## 📈 Dashboard Features

- **Overview**: Portfolio stats, open/closed positions, win rate
- **Trades**: Seznam všech paper trades s filtrováním
- **History**: Portfolio value over time chart a historie snapshots

## 🔧 Troubleshooting

### Worker nekopíruje trades
- Zkontroluj `PAPER_TRADING_ENABLED=true`
- Zkontroluj, jestli jsou nové trades v databázi
- Zkontroluj logy workeru

### Paper trades se neuzavírají
- Zkontroluj, jestli existuje otevřená pozice pro daný token a wallet
- Zkontroluj, jestli SELL trade má správný `walletId` a `tokenId`

### Portfolio stats jsou špatné
- Zkontroluj, jestli jsou paper trades správně uzavřené (status='closed')
- Zkontroluj, jestli `realizedPnl` je správně vypočítané

## 🚀 Next Steps (Fáze 2: AI Decision Engine)

Po ověření základního paper tradingu můžeme přidat:
- AI/LLM rozhodovací vrstvu
- Pokročilé risk management rules
- Position sizing logic
- Multi-wallet aggregation

Viz `AI_TRADING_SYSTEM_DESIGN.md` pro detaily.
