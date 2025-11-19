# 🚀 Jak spustit tracking

## 1. Zkontroluj konfiguraci

### V `.env` souboru (apps/backend/.env):

```bash
# Helius API (doporučeno - lepší detekce swapů)
HELIUS_API_KEY=your-helius-api-key-here

# Solana RPC (fallback, pokud nemáš Helius)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
# nebo použij Alchemy:
# SOLANA_RPC_URL=https://solana-mainnet.g.alchemy.com/v2/your-key

# Collector konfigurace
COLLECTOR_INTERVAL_SECONDS=60  # Jak často kontrolovat nové transakce (v sekundách)
COLLECTOR_MAX_TX_PER_WALLET=50  # Kolik transakcí zpracovat na wallet při každém kole
```

## 2. Spusť tracking servisy

### A) Helius/RPC Collector (pro swapy z různých DEXů)

```bash
# Z kořenového adresáře projektu
pnpm --filter backend collector:start
```

**Co dělá:**
- Každých 60 sekund (nebo podle `COLLECTOR_INTERVAL_SECONDS`) projde všechny smart wallets
- Použije Helius Enhanced API pokud je `HELIUS_API_KEY` nastaven
- Fallback na RPC parsing pokud Helius není dostupné
- Ukládá swapy do `Trade` tabulky

**Logy:**
- `✅ Helius API enabled` - používá Helius
- `⚠️ Helius API not configured` - používá RPC fallback
- `✅ Collection round completed` - každé kolo sběru

### B) Pump.fun Stream (realtime tracking Pump.fun tradeů)

```bash
# Z kořenového adresáře projektu
pnpm --filter backend pumpfun:stream
```

**Co dělá:**
- Připojí se na Pump.fun WebSocket (`wss://pumpportal.fun/api/data`)
- Sleduje všechny smart wallets z databáze
- Ukládá Pump.fun trady do `Trade` tabulky v reálném čase

**Logy:**
- `✅ Connected to Pump.fun WebSocket` - připojeno
- `✅ Subscribed to X wallets` - sleduje X walletů
- `✅ Pump.fun trade saved` - uložený trade

## 3. Spusť oba servisy současně

### V terminálu 1 (Collector):
```bash
cd /Users/stepanpanek/Desktop/Coding/Bots/tradooor
pnpm --filter backend collector:start
```

### V terminálu 2 (Pump.fun Stream):
```bash
cd /Users/stepanpanek/Desktop/Coding/Bots/tradooor
pnpm --filter backend pumpfun:stream
```

### Nebo použij `screen` / `tmux` pro běh na pozadí:

```bash
# Screen
screen -S tradooor-collector
pnpm --filter backend collector:start
# Ctrl+A, D pro odpojení

screen -S tradooor-pumpfun
pnpm --filter backend pumpfun:stream
# Ctrl+A, D pro odpojení

# Znovu připojit: screen -r tradooor-collector
```

## 4. Zkontroluj, že to funguje

### V Supabase SQL Editor:
```sql
-- Zkontroluj, jestli se ukládají nové trady
SELECT 
  COUNT(*) as total_trades,
  COUNT(DISTINCT "walletId") as wallets_with_trades,
  MIN("timestamp") as oldest_trade,
  MAX("timestamp") as newest_trade
FROM "Trade";

-- Posledních 10 tradeů
SELECT 
  t."txSignature",
  t."side",
  t."amountToken",
  t."amountBase",
  t."timestamp",
  t."dex",
  w."address",
  w."label"
FROM "Trade" t
JOIN "SmartWallet" w ON t."walletId" = w."id"
ORDER BY t."timestamp" DESC
LIMIT 10;
```

### V frontendu:
- Otevři `/wallets` stránku
- Klikni na "🔄 Refresh"
- Měly by se začít objevovat nové trady a metriky

## 5. Přepočet metrik

Po nasbírání nějakých dat můžeš přepočítat metriky:

```bash
# Pro všechny wallets
pnpm --filter backend calculate-metrics

# Pro konkrétní wallet
pnpm --filter backend calculate-metrics WALLET_ID
```

## Troubleshooting

### Collector neukládá žádné trady:
1. Zkontroluj, jestli máš nějaké smart wallets v databázi
2. Zkontroluj logy - jsou tam chyby?
3. Zkontroluj `HELIUS_API_KEY` - je správně nastaven?
4. Zkontroluj rate limits - možná je potřeba zvýšit delay

### Pump.fun stream se nepřipojuje:
1. Zkontroluj internetové připojení
2. Zkontroluj, jestli Pump.fun WebSocket není down
3. Zkontroluj logy - jsou tam chyby?

### Data se neobjevují ve frontendu:
1. Hard refresh stránky (Ctrl+Shift+R / Cmd+Shift+R)
2. Zkontroluj, jestli backend běží
3. Zkontroluj konzoli prohlížeče (F12) pro chyby

