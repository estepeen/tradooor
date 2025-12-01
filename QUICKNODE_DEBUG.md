# QuickNode Webhook Debug Guide

## Jak sledovat, že QuickNode webhook funguje správně s USD hodnotami

### 1. Sledování logů v reálném čase

```bash
# Na produkčním serveru
pm2 logs tradooor-backend --lines 100

# Nebo tail log souboru
tail -f ~/.pm2/logs/tradooor-backend-out.log
```

### 2. Co hledat v logách

#### ✅ Úspěšný webhook request
```
📨 ===== QUICKNODE WEBHOOK REQUEST RECEIVED (FROM ROUTER) =====
   Time: 2025-12-01T...
   IP: ...
📨 ===== QUICKNODE WEBHOOK PROCESSING STARTED =====
📨 Received QuickNode webhook: X transaction(s) at blockTime=...
```

#### ✅ Úspěšná normalizace swapu
```
   [QuickNode] Normalized swap: BUY 100.0000 tokens for $50.00 USD
      Original: 0.500000 SOL → Converted: $50.00 USD
      Price: $0.50000000 USD per token
```

#### ✅ USD konverze
```
   💵 [QuickNode USD] SOL conversion: 0.500000 SOL × $100.00 = $50.00 USD
   💵 [QuickNode USD] USDC (1:1): 50.000000 USDC = $50.00 USD
   💵 [QuickNode USD] Token-to-token swap: fetching USD price for secondary token...
   💵 [QuickNode USD] Token-to-token: 100.000000 tokens × $0.500000 = $50.00 USD
```

#### ✅ Uložení trade do DB
```
   ✅ [QuickNode] Trade saved: abc12345...
      BUY: 100.0000 tokens
      Value: $50.00 USD (original: 0.500000 SOL)
      Price: $0.50000000 USD per token
      Token: 7xKXtg2CW8...
```

#### ⚠️ Varování (ale stále funguje)
```
   ⚠️  [QuickNode] Cannot get USD price for secondary token..., using SOL price as fallback
   ⚠️  [QuickNode] Failed to convert to USD: ...
```

#### ❌ Chyby (nefunguje)
```
   ❌ [QuickNode] Failed to get SOL price for USD conversion: ...
   ⚠️  [QuickNode] Skipping tiny trade (amountBase=$0.05 USD < $0.10)...
```

### 3. Test endpointy

#### Test, že endpoint funguje
```bash
curl -X GET https://tradooor.stepanpanek.cz/api/webhooks/quicknode/test
```

Očekávaná odpověď:
```json
{
  "success": true,
  "message": "QuickNode webhook endpoint is working!",
  "timestamp": "2025-12-01T..."
}
```

#### Test s minimálním payloadem
```bash
curl -X POST https://tradooor.stepanpanek.cz/api/webhooks/quicknode/test-minimal \
  -H "Content-Type: application/json" \
  -d '{}'
```

### 4. Kontrola v databázi

#### Zkontroluj poslední QuickNode trady
```sql
SELECT 
  t.id,
  t."txSignature",
  t.side,
  t."amountToken",
  t."amountBase",  -- Mělo by být v USD
  t."priceBasePerToken",  -- Mělo by být v USD
  t."valueUsd",  -- Mělo by být stejné jako amountBase
  t.meta->>'baseToken' as base_token,
  t.meta->>'isTokenToTokenSwap' as is_token_to_token,
  t."timestamp",
  tok.symbol as token_symbol,
  w.address as wallet_address
FROM trades t
JOIN tokens tok ON t."tokenId" = tok.id
JOIN smart_wallets w ON t."walletId" = w.id
WHERE t.meta->>'source' = 'quicknode-webhook'
ORDER BY t."timestamp" DESC
LIMIT 10;
```

#### Očekávané hodnoty:
- `amountBase` by mělo být v USD (např. 50.00 místo 0.5)
- `priceBasePerToken` by mělo být v USD (např. 0.50 místo 0.005)
- `valueUsd` by mělo být stejné jako `amountBase`
- Pro SOL swapy: `baseToken` = 'SOL', ale `amountBase` je v USD
- Pro token-to-token swapy: `isTokenToTokenSwap` = 'true'

### 5. Sledování metrik

#### Zkontroluj, že PnL je v USD
```sql
SELECT 
  address,
  "pnlTotalBase",  -- Mělo by být v USD (ne SOL)
  "recentPnl30dUsd",  -- Mělo by být v USD
  "totalTrades",
  "winRate"
FROM smart_wallets
ORDER BY "updatedAt" DESC
LIMIT 10;
```

### 6. Debug flagy (volitelné)

Pokud chceš ještě více detailů, můžeš přidat do `.env`:
```bash
DEBUG_QUICKNODE=true
DEBUG_USD_CONVERSION=true
```

A pak v kódu:
```typescript
if (process.env.DEBUG_QUICKNODE === 'true') {
  console.log('🔍 [DEBUG] Detailed info...');
}
```

### 7. Časté problémy

#### Problém: amountBase je stále v SOL
- **Příčina**: QuickNode webhook se nespustil nebo selhal převod na USD
- **Řešení**: Zkontroluj logy pro chyby v USD konverzi

#### Problém: valueUsd je null
- **Příčina**: Selhal výpočet USD hodnoty
- **Řešení**: Zkontroluj, jestli Binance API funguje (SOL price)

#### Problém: Token-to-token swapy nemají USD hodnotu
- **Příčina**: TokenPriceService nemůže získat cenu sekundárního tokenu
- **Řešení**: Zkontroluj logy - měl by se použít fallback na SOL price

### 8. Monitoring

Doporučené sledování:
1. **Počet webhook requestů**: `grep "QUICKNODE WEBHOOK REQUEST" ~/.pm2/logs/tradooor-backend-out.log | wc -l`
2. **Počet uložených tradeů**: `grep "QuickNode.*Trade saved" ~/.pm2/logs/tradooor-backend-out.log | wc -l`
3. **Chyby**: `grep "❌.*QuickNode" ~/.pm2/logs/tradooor-backend-error.log`

### 9. Testování lokálně

```bash
# Spusť backend s debug logy
cd apps/backend
pnpm start

# V jiném terminálu pošli test webhook
curl -X POST http://localhost:3001/api/webhooks/quicknode/test-minimal \
  -H "Content-Type: application/json" \
  -d '{}'
```

