# Reset všech dat - Návod

Tento dokument popisuje, jak kompletně resetovat všechna trades data a začít od nuly.

## ⚠️ VAROVÁNÍ

**Tento proces smaže:**
- Všechny trades
- Všechny closed lots
- Všechny trade features
- Všechny normalized trades
- Portfolio baseline cache
- Wallet processing queue
- Metrics history
- Všechny wallet metriky (score, winRate, totalTrades, PnL, atd.)
- Všechny tagy (auto-generated i user-defined)

**Co zůstane:**
- SmartWallet záznamy (adresy, labely, twitterUrl)
- Token záznamy
- Webhook setup

## Postup

### 1. Vymazat všechna trades data

```bash
cd apps/backend
pnpm trades:delete-all
```

Tento script:
- Smaže všechny trades a související data
- Resetuje všechny wallet metriky na 0
- Smaže všechny tagy

### 2. Zkontrolovat webhook setup (volitelné)

Pokud používáš Helius webhooky pro real-time sběr trades:

```bash
# Zkontroluj, že webhook existuje
curl -X POST http://localhost:3001/api/smart-wallets/setup-webhook
```

**Poznámka:** Webhooky nejsou povinné - cron job každou hodinu zkontroluje všechny trades přes QuickNode RPC a doplní chybějící.

### 3. Spustit periodickou kontrolu chybějících trades

Pro kontrolu, jestli webhook nevynechal nějaký trade, spusť cron job:

```bash
# Spustit jednou (pro testování)
RUN_ON_START=true pnpm check-missing-trades:cron

# Nebo spustit jako dlouhodobý proces (každou hodinu)
pnpm check-missing-trades:cron
```

Tento cron job:
- Každou hodinu kontroluje všechny peněženky
- Získá transakce z RPC za poslední hodinu
- Porovná s trades v DB
- Pokud najde chybějící, zpracuje je

### 4. Nastavení RPC endpointu

Ujisti se, že máš nastavený QuickNode RPC URL v `.env`:

```env
QUICKNODE_RPC_URL=https://your-quicknode-url
```

**Poznámka:** Cron job preferuje QuickNode RPC. Helius RPC není potřeba pro kontrolu chybějících trades (používá se pouze pro webhooky, pokud je používáš).

### 5. Zkontrolovat, jestli se vše hlídá správně

Po resetu:
1. **Zkontroluj webhook logy** - měly by se zobrazovat nové trades při jejich provedení
2. **Zkontroluj cron job logy** - měl by najít a zpracovat chybějící trades
3. **Zkontroluj frontend** - měly by se zobrazovat nové trades a aktualizované metriky

## Monitoring

### Webhook monitoring

Webhook endpoint loguje:
- Počet přijatých transakcí
- Počet uložených swaps
- Počet přeskočených (duplikáty, non-swaps)
- Chyby při zpracování

### Cron job monitoring

Cron job loguje:
- Počet kontrolovaných peněženek
- Počet nalezených transakcí z QuickNode RPC
- Počet chybějících trades
- Počet uložených trades
- Chyby při zpracování

**RPC endpoint:** Cron job používá `QUICKNODE_RPC_URL` z `.env` souboru.

## Troubleshooting

### Webhook nepřijímá trades

1. Zkontroluj, že webhook URL je veřejně dostupná
2. Zkontroluj Helius dashboard - webhook by měl existovat
3. Zkontroluj backend logy

### Cron job nenachází trades

1. Zkontroluj, že RPC URL je správně nastaveno
2. Zkontroluj, že RPC endpoint funguje
3. Zkontroluj logy pro chybové zprávy

### Trades se nezobrazují ve frontendu

1. Zkontroluj, že backend běží
2. Zkontroluj, že trades jsou v databázi
3. Zkontroluj frontend logy pro chyby

## Automatizace

Pro produkci doporučujeme:

1. **Cron job pro chybějící trades** - každou hodinu kontroluje všechny peněženky přes QuickNode RPC a doplní chybějící trades
2. **Metrics cron** - každou hodinu přepočítává metriky
3. **Webhook (volitelné)** - pokud používáš Helius webhooky, automaticky přijímá trades v reálném čase

Všechny tyto procesy mohou běžet současně. Cron job funguje jako backup mechanismus, který zajistí, že žádný trade nebude vynechán.
