# QuickNode Webhook Monitoring

Tento dokument popisuje, jak zkontrolovat, že QuickNode webhook funguje a přijímá notifikace.

## 1. Test Webhook Endpointu

### Základní test
```bash
curl -X POST https://tradooor.stepanpanek.cz/api/webhooks/quicknode/test
```

Očekávaná odpověď:
```json
{
  "success": true,
  "message": "QuickNode webhook endpoint is working!",
  "timestamp": "2025-12-01T..."
}
```

### Test s minimálním payloadem
```bash
curl -X POST https://tradooor.stepanpanek.cz/api/webhooks/quicknode/test-minimal \
  -H "Content-Type: application/json" \
  -d '{}'
```

## 2. Kontrola Backend Logů

### PM2 Logy (na serveru)
```bash
# Posledních 100 řádků s QuickNode záznamy
pm2 logs tradooor-backend --lines 100 --nostream | grep -i quicknode

# Nebo všechny logy v reálném čase
pm2 logs tradooor-backend --lines 0 | grep --line-buffered -i quicknode
```

### Co hledat v logách:

✅ **Úspěšné zpracování:**
```
📨 ===== QUICKNODE WEBHOOK REQUEST RECEIVED (FROM ROUTER) =====
   Found 2 transaction(s), blockTime=1764616217
   [QuickNode] Normalized swap: buy 100.5 tokens for $50.25 USD (SOL)
   ✅ [QuickNode] Trade saved: abc12345... (buy 100.5 tokens, 50.25 SOL)
```

⚠️ **Skipped transakce (normální, pokud nejsou swapy):**
```
   ⏭️  Skipping transaction: missing message or meta
   ⏭️  Skipping transaction: wallet not tracked
```

❌ **Chyby:**
```
❌ Error processing QuickNode webhook in background: ...
⚠️  Invalid QuickNode webhook payload - no transactions found
```

## 3. Kontrola Nginx Logů

### Access logy (úspěšné requesty)
```bash
sudo tail -n 100 /var/log/nginx/tradooor-access.log | grep quicknode
```

Očekávaný výstup:
```
POST /api/webhooks/quicknode HTTP/2.0 200 ...
```

### Error logy (chyby)
```bash
sudo tail -n 50 /var/log/nginx/tradooor-error.log
```

## 4. Kontrola Databáze

### Poslední QuickNode trady
```bash
# Připoj se k databázi
psql $DATABASE_URL

# Zobraz posledních 10 QuickNode tradeů
SELECT 
  id,
  "txSignature",
  side,
  "amountToken",
  "amountBase",
  "valueUsd",
  timestamp,
  meta->>'source' as source,
  meta->>'baseToken' as base_token
FROM trades 
WHERE meta->>'source' = 'quicknode-webhook' 
ORDER BY timestamp DESC 
LIMIT 10;
```

### Počet QuickNode tradeů za poslední hodinu
```sql
SELECT 
  COUNT(*) as total_trades,
  COUNT(DISTINCT "walletId") as unique_wallets,
  SUM("valueUsd") as total_volume_usd
FROM trades 
WHERE meta->>'source' = 'quicknode-webhook' 
  AND timestamp > NOW() - INTERVAL '1 hour';
```

### Počet tradeů podle base tokenu
```sql
SELECT 
  meta->>'baseToken' as base_token,
  COUNT(*) as count,
  SUM("valueUsd") as total_volume_usd
FROM trades 
WHERE meta->>'source' = 'quicknode-webhook' 
  AND timestamp > NOW() - INTERVAL '24 hours'
GROUP BY meta->>'baseToken'
ORDER BY count DESC;
```

## 5. QuickNode Dashboard

1. Přihlas se na https://dashboard.quicknode.com
2. Jdi na **Notifications** → **Streams** (nebo **QuickAlerts**)
3. Najdi svůj webhook stream
4. Zkontroluj:
   - ✅ **Status**: Mělo by být "Active" nebo "Running"
   - ✅ **Delivery Status**: Mělo by být "Success" (zelená)
   - ✅ **Last Delivery**: Mělo by být nedávné (např. před 1-5 minutami)
   - ✅ **Total Deliveries**: Mělo by se zvyšovat

### Co znamenají statusy:
- **Active/Running**: Webhook běží a posílá notifikace
- **Paused**: Webhook je pozastaven (není aktivní)
- **Failed**: Webhook selhal (zkontroluj URL a konfiguraci)
- **Success (zelená)**: Poslední delivery byla úspěšná
- **Failed (červená)**: Poslední delivery selhala (zkontroluj backend logy)

## 6. Monitoring Skript

Použij připravený skript:
```bash
./check-quicknode-webhook.sh
```

Nebo na serveru:
```bash
cd /opt/tradooor
./check-quicknode-webhook.sh
```

## 7. Reálný Čas Monitoring

### Sledování logů v reálném čase
```bash
# Na serveru
pm2 logs tradooor-backend --lines 0 | grep --line-buffered -i 'quicknode\|webhook\|trade saved'
```

### Watch příkaz (aktualizace každých 5 sekund)
```bash
watch -n 5 'pm2 logs tradooor-backend --lines 20 --nostream | grep -i quicknode | tail -10'
```

## 8. Očekávané Chování

### ✅ Funguje správně, když:
1. **QuickNode dashboard** ukazuje "Active" status a "Success" deliveries
2. **Backend logy** obsahují záznamy typu:
   - `📨 QUICKNODE WEBHOOK REQUEST RECEIVED`
   - `✅ [QuickNode] Trade saved`
3. **Databáze** obsahuje nové trady s `meta->>'source' = 'quicknode-webhook'`
4. **Nginx access logy** obsahují `POST /api/webhooks/quicknode HTTP/2.0 200`

### ⚠️ Normální chování (není chyba):
- **Skipped transakce**: Většina transakcí bude skipnutá, protože nejsou swapy nebo neobsahují tracked wallet
- **"Invalid QuickNode webhook payload"**: Může se objevit, pokud QuickNode posílá prázdné payloady (normální)

### ❌ Problém, když:
1. **QuickNode dashboard** ukazuje "Failed" deliveries
2. **Backend logy** obsahují chyby typu:
   - `❌ Error processing QuickNode webhook`
   - `PayloadTooLargeError`
3. **Nginx error logy** obsahují `502 Bad Gateway` nebo `504 Gateway Timeout`
4. **Databáze** neobsahuje žádné nové QuickNode trady za poslední hodinu

## 9. Troubleshooting

### Webhook nefunguje
1. Zkontroluj, že backend běží: `pm2 status`
2. Zkontroluj, že endpoint je dostupný: `curl https://tradooor.stepanpanek.cz/api/webhooks/quicknode/test`
3. Zkontroluj QuickNode dashboard - jestli je webhook aktivní
4. Zkontroluj Nginx logy pro chyby

### Webhook přijímá requesty, ale neukládá trady
1. Zkontroluj, že wallet adresy v `wallets.csv` jsou správně zadané
2. Zkontroluj, že QuickNode filter správně filtruje swapy
3. Zkontroluj backend logy - jestli jsou trady skipnuté a proč

### Webhook je pomalý
1. Zkontroluj, že Nginx má dostatečné timeouty (`client_max_body_size 10M`)
2. Zkontroluj, že backend má dostatek paměti
3. Zkontroluj, že databáze není přetížená

## 10. Metriky pro Monitoring

### Počet requestů za hodinu
```sql
SELECT 
  DATE_TRUNC('hour', timestamp) as hour,
  COUNT(*) as requests
FROM trades 
WHERE meta->>'source' = 'quicknode-webhook' 
  AND timestamp > NOW() - INTERVAL '24 hours'
GROUP BY hour
ORDER BY hour DESC;
```

### Průměrná hodnota tradeu
```sql
SELECT 
  AVG("valueUsd") as avg_value_usd,
  MIN("valueUsd") as min_value_usd,
  MAX("valueUsd") as max_value_usd,
  COUNT(*) as total_trades
FROM trades 
WHERE meta->>'source' = 'quicknode-webhook' 
  AND timestamp > NOW() - INTERVAL '24 hours';
```

