# Pump.fun WebSocket Stream

Realtime tracking Pump.fun trades přes WebSocket API.

## Jak to funguje

1. **Připojí se na `wss://pumpportal.fun/api/data`**
2. **Sleduje všechny smart wallets z databáze** (`subscribeAccountTrade`)
3. **Když přijde trade**, automaticky ho uloží do `Trade` tabulky
4. **Přesnější než RPC heuristika** - dostáváme přímo strukturovaná data od Pump.fun

## Spuštění

```bash
# Spustit Pump.fun stream (běží na pozadí)
pnpm --filter backend pumpfun:stream
```

## Výhody

✅ **Přesnější data** - přímo od Pump.fun, ne heuristika  
✅ **Realtime** - trady se ukládají okamžitě  
✅ **Méně false positives** - Pump.fun ví, co je swap  
✅ **Jednodušší** - nemusíme parsovat RPC transakce  

## Limity

⚠️ **Jen Pump.fun** - ostatní DEXy (Raydium, Jupiter) stále přes RPC collector  
⚠️ **Jen nová data** - historie se musí dohnat přes `collector:backfill`  
⚠️ **Závislost na API** - pokud Pump.fun API padne, stream se zastaví  

## Kombinace s RPC collectorem

Doporučený setup:

1. **Pump.fun stream** - pro realtime Pump.fun trady
   ```bash
   pnpm --filter backend pumpfun:stream
   ```

2. **RPC collector** - pro ostatní DEXy + historie
   ```bash
   pnpm --filter backend collector:start
   ```

3. **Metriky cron** - periodický přepočet
   ```bash
   pnpm --filter backend metrics:cron
   ```

## Debugging

Service automaticky loguje:
- Připojení k WebSocketu
- Přihlášení k odběru wallets
- Ukázky zpráv (10% náhodně pro debugging)
- Uložené trady
- Chyby

Pokud nevidíš trady:
1. Zkontroluj, jestli jsou smart wallets v databázi
2. Zkontroluj logy - možná je jiný formát zpráv
3. Pošli mi příklad zprávy z WebSocketu, upravím parser

