# QuickNode Credit Optimization

## Problém

QuickNode webhook spotřebovává desetitisíce kreditů za hodinu, i když máš nastavených jen 120 wallets. Problém je, že QuickNode posílá **všechny transakce** s tracked wallet, i když to nejsou swapy.

**Kredity se spotřebovávají už při odeslání webhooku**, ne až při skipování na backendu!

## Řešení: Agresivní filtrování v QuickNode Streams Filter

QuickNode Streams filter musí filtrovat **PŘED odesláním webhooku**, ne až na backendu. Upravil jsem filter, aby:

1. ✅ **Vyžaduje DEX program** - bez DEX programu = skip (není swap)
2. ✅ **Vyžaduje tracked wallet** - bez tracked wallet = skip
3. ✅ **Vyžaduje alespoň 2 tokeny se změnou** - swap, ne transfer
4. ✅ **Vyžaduje non-base token** - ne jen SOL/USDC/USDT swapy

## Co jsem změnil

### 1. Vylepšený DEX program check
```javascript
// BEZ DEX PROGRAMU = NENÍ SWAP = SKIP (šetří kredity!)
if (!hasDexProgram) continue;
```

### 2. Přidán check pro non-base token
```javascript
// Swap musí mít alespoň jeden non-base token
// (ne jen SOL/USDC/USDT swapy)
if (tokensWithChange >= 2 && hasNonBaseToken) {
  relevantTransactions.push(tx);
}
```

## Jak aktualizovat filter v QuickNode

### Krok 1: Vygeneruj nový filter
```bash
./generate-quicknode-filter.sh
```

Tím se vytvoří `quicknode-streams-filter-generated.js` s:
- Všemi tracked wallets z `wallets.csv`
- Vylepšeným filtrováním (DEX program + non-base token)

### Krok 2: Zkopíruj do QuickNode Dashboard

1. Otevři `quicknode-streams-filter-generated.js`
2. Zkopíruj celý obsah
3. Jdi do [QuickNode Dashboard](https://dashboard.quicknode.com/) → Streams
4. Najdi svůj webhook stream
5. Klikni na "Edit" nebo "Configure"
6. Vlož nový kód do "Filter Function"
7. Ulož změny

### Krok 3: Ověř, že to funguje

Po aktualizaci filtru by měl QuickNode posílat **mnohem méně** webhook requestů:

```bash
# Sleduj logy
pm2 logs tradooor-backend --lines 0 | grep --line-buffered -i quicknode
```

Mělo by být vidět:
- ✅ Méně webhook requestů (místo desetitisíců za hodinu, jen stovky)
- ✅ Většina requestů obsahuje skutečné swapy
- ✅ Méně skipnutých transakcí na backendu

## Porovnání s Helius

**Helius:**
- ✅ Trackuje **pouze swapy** (Enhanced Transactions API)
- ✅ Automaticky filtruje non-swap transakce
- ✅ Nízká spotřeba kreditů

**QuickNode (před opravou):**
- ❌ Posílá **všechny transakce** s tracked wallet
- ❌ Backend skipuje většinu transakcí (ale kredity už jsou spotřebované)
- ❌ Vysoká spotřeba kreditů

**QuickNode (po opravě):**
- ✅ Filtruje **pouze swapy** v QuickNode Streams filteru
- ✅ Posílá jen relevantní transakce
- ✅ Nízká spotřeba kreditů (podobně jako Helius)

## Monitoring spotřeby kreditů

### V QuickNode Dashboard:
1. Jdi na **Billing** → **Usage**
2. Sleduj **Streams/QuickAlerts** spotřebu
3. Po aktualizaci filtru by měla spotřeba výrazně klesnout

### Očekávané výsledky:
- **Před opravou**: 10 000+ kreditů za hodinu
- **Po opravě**: 100-500 kreditů za hodinu (závisí na aktivitě tracked wallets)

## Troubleshooting

### Webhook stále spotřebovává hodně kreditů

1. **Zkontroluj, jestli je filter správně uložený**
   - QuickNode Dashboard → Streams → Edit
   - Ověř, že Filter Function obsahuje nový kód

2. **Zkontroluj, jestli jsou DEX programy správné**
   - Možná používáš jiné DEX programy
   - Přidej je do `DEX_PROGRAMS` setu

3. **Zkontroluj, jestli jsou tracked wallets správné**
   - Spusť `./generate-quicknode-filter.sh` znovu
   - Ověř, že všechny adresy jsou v `TRACKED_WALLETS` setu

### Webhook neposílá žádné transakce

1. **Zkontroluj, jestli tracked wallets skutečně tradují**
   - Možná jsou neaktivní
   - Zkontroluj na Solscan

2. **Zkontroluj, jestli swapy používají podporované DEX programy**
   - Možná používají jiné DEX programy
   - Přidej je do `DEX_PROGRAMS` setu

3. **Zkontroluj QuickNode logs**
   - QuickNode Dashboard → Streams → Logs
   - Hledej chyby v filter funkci

## Alternativní řešení: QuickAlerts

Pokud QuickNode Streams stále spotřebovává hodně kreditů, zvaž použití **QuickAlerts** místo Streams:

- QuickAlerts umožňuje ještě agresivnější filtrování
- Může být levnější pro malý počet tracked wallets
- Podporuje podobné filter funkce jako Streams

## Závěr

Po aktualizaci QuickNode Streams filteru by měla spotřeba kreditů klesnout z **desetitisíců za hodinu** na **stovky za hodinu** (podobně jako Helius).

**Klíčové je filtrovat PŘED odesláním webhooku**, ne až na backendu!

