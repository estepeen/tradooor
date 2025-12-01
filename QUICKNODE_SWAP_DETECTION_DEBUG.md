# QuickNode Swap Detection - Debug Guide

## Možné problémy s detekcí swapů

### 1. QuickNode posílá špatný formát dat

**Příznaky:**
- Všechny transakce jsou skipnuté s "missing message or meta"
- V logách vidíš: `⏭️  Skipped X transactions (missing message or meta)`

**Řešení:**
- Zkontroluj QuickNode Streams filter - měl by posílat transakce ve formátu:
  ```javascript
  {
    transaction: {
      message: { accountKeys: [...], ... },
      signatures: [...]
    },
    meta: {
      preTokenBalances: [...],
      postTokenBalances: [...],
      preBalances: [...],
      postBalances: [...]
    }
  }
  ```

### 2. Wallet adresy nejsou v databázi

**Příznaky:**
- V logách vidíš: `⏭️  Skipped X transactions (no tracked wallet involved)`
- Transakce mají `message` a `meta`, ale žádná wallet není nalezena

**Řešení:**
```bash
# Zkontroluj, jestli jsou wallet adresy v DB
psql $DATABASE_URL -c "SELECT address FROM smart_wallets LIMIT 10;"

# Zkontroluj, jestli jsou wallet adresy v wallets.csv
cat wallets.csv | head -5
```

### 3. Transakce nejsou swapy

**Příznaky:**
- V logách vidíš: `⏭️  [QuickNode] Skipped tx ...: not a swap`
- Transakce obsahuje tracked wallet, ale není to swap

**Možné důvody:**
- Transfer (pouze jeden token se mění)
- Stake/unstake
- Airdrop
- Jiná operace (ne swap)

**Řešení:**
- To je normální - QuickNode filter by měl filtrovat pouze swapy
- Zkontroluj QuickNode Streams filter - měl by kontrolovat:
  1. DEX program involvement
  2. Alespoň 2 tokeny se změnou
  3. Tracked wallet involvement

### 4. Swap nemá primární token (non-base token)

**Příznaky:**
- V logách vidíš: `⚠️  [QuickNode] No primary token found for wallet ...`
- Token net changes jsou prázdné nebo obsahují pouze base tokeny (SOL/USDC/USDT)

**Možné důvody:**
- Swap je pouze mezi base tokeny (např. SOL → USDC)
- QuickNode neposílá správné token balance data

**Řešení:**
- Zkontroluj QuickNode Streams filter - měl by filtrovat swapy s non-base tokeny
- Nebo uprav logiku, aby detekovala i base-to-base swapy (pokud je chceš trackovat)

### 5. Swap nemá base token (SOL/USDC/USDT)

**Příznaky:**
- V logách vidíš: `⚠️  [QuickNode] No base token found for BUY/SELL swap`
- Token net changes obsahují pouze non-base tokeny

**Možné důvody:**
- Token za token swap (např. TRUMP → TROLL)
- QuickNode neposílá správné token balance data

**Řešení:**
- To by mělo být podporováno (token za token swapy)
- Zkontroluj, jestli sekundární token má cenu v USD (TokenPriceService)

### 6. Swap je příliš malý

**Příznaky:**
- V logách vidíš: `⚠️  [QuickNode] Skipping tiny trade (amountBase=$X USD < $0.10)`

**Řešení:**
- To je normální - filtrujeme malé trady (pravděpodobně fees)
- Pokud chceš trackovat i malé trady, sniž threshold v `processQuickNodeTransaction`

## Debug kroky

### 1. Zkontroluj logy s novým debug loggingem

```bash
pm2 logs tradooor-backend --lines 200 --nostream | grep -i quicknode
```

Hledej:
- `⚠️  [QuickNode] No primary token found` - swap nemá primární token
- `⚠️  [QuickNode] No base token found` - swap nemá base token
- `⚠️  [QuickNode] Invalid baseAmount or amountToken` - swap má neplatné hodnoty
- `⏭️  [QuickNode] Skipped tx ...: not a swap` - transakce není swap
- `⏭️  Skipped X transactions (no tracked wallet involved)` - žádná tracked wallet v transakci

### 2. Zkontroluj QuickNode Streams filter

Filter by měl:
1. Filtrovat pouze swapy (DEX program involvement)
2. Filtrovat pouze swapy s tracked wallets
3. Filtrovat pouze swapy s base tokeny (SOL/USDC/USDT) nebo token za token swapy

### 3. Zkontroluj formát dat z QuickNode

Přidej do `processQuickNodeWebhook` debug logging:
```typescript
console.log('   Transaction keys:', Object.keys(tx || {}));
console.log('   Has message:', !!tx.transaction?.message);
console.log('   Has meta:', !!tx.meta);
console.log('   PreTokenBalances:', tx.meta?.preTokenBalances?.length || 0);
console.log('   PostTokenBalances:', tx.meta?.postTokenBalances?.length || 0);
```

### 4. Zkontroluj, jestli QuickNode posílá správné data

V QuickNode Dashboard:
1. Jdi na Notifications → Streams
2. Zkontroluj webhook delivery status
3. Zkontroluj, jestli webhook posílá data (Total Deliveries > 0)
4. Zkontroluj, jestli jsou delivery úspěšné (Success status)

## Očekávané chování

### ✅ Funguje správně, když:
1. QuickNode posílá swapy s tracked wallets
2. Swapy obsahují primární token (non-base) a base token (SOL/USDC/USDT)
3. V logách vidíš: `✅ [QuickNode] Saved swap: ...`
4. V databázi se ukládají nové trady

### ⚠️ Normální chování (není chyba):
- Většina transakcí bude skipnutá (nejsou swapy nebo neobsahují tracked wallet)
- Malé trady (< $0.10 USD) budou skipnuté (filtrujeme fees)
- Base-to-base swapy (SOL → USDC) budou skipnuté (nemají primární token)

### ❌ Problém, když:
1. Všechny transakce jsou skipnuté s "missing message or meta" - QuickNode posílá špatný formát
2. Swapy mají tracked wallet, ale jsou skipnuté s "not a swap" - problém s detekcí swapů
3. Swapy mají primární token, ale jsou skipnuté s "No base token found" - problém s detekcí base tokenu

## Rychlá diagnostika

```bash
# 1. Zkontroluj logy
pm2 logs tradooor-backend --lines 100 --nostream | grep -i quicknode

# 2. Zkontroluj, jestli jsou wallet adresy v DB
psql $DATABASE_URL -c "SELECT COUNT(*) FROM smart_wallets;"

# 3. Zkontroluj, jestli se ukládají trady
psql $DATABASE_URL -c "SELECT COUNT(*) FROM trades WHERE meta->>'source' = 'quicknode-webhook' AND timestamp > NOW() - INTERVAL '1 hour';"

# 4. Zkontroluj QuickNode dashboard
# https://dashboard.quicknode.com → Notifications → Streams
```

