# Analýza chybějících trades

## Problém
Mezi POKEPALM SELL (8:23:38 AM) a prvním NALA BUY (9:46:50 AM) je mezera **83 minut**, kde by měly být další trades, ale v databázi jich máme jen 14.

## Možné příčiny

### 1. QuickNode webhooky neposílají všechny transakce
- QuickNode Streams/QuickAlerts mohou mít filtry
- Některé transakce mohou být vynechány kvůli formátu
- Webhooky mohou být nastavené jen na určité typy transakcí

### 2. `normalizeQuickNodeSwap` vrací `null`
Funkce vrací `null` pokud:
- **Není primary token** (řádek 230-236): `if (!primaryMint || Math.abs(primaryDelta) < 1e-9)`
- **baseAmount <= 0 nebo amountToken <= 0** (řádek 329-335): pro normální trades
- **Není signature** (řádek 342): `if (!signature) return null;`

### 3. Filtry v `processQuickNodeWebhook`
Transakce se skipují pokud:
- **Nemají message nebo meta** (řádek 277-284)
- **Mají tx.raw nebo tx.wallets** (řádek 288-291) - jiný formát
- **Neobsahují tracked wallet** (řádek 320-327)

### 4. Tiny trades filter
V `processWebhookTransaction` (Helius) je filtr pro tiny SOL trades < 0.03 SOL, ale v QuickNode path není.

## Řešení

### Okamžité kroky:
1. **Zkontrolovat QuickNode webhook nastavení** - zda jsou všechny transakce posílány
2. **Zkontrolovat logy** - kolik transakcí se skipuje a proč
3. **Přidat více logování** - aby bylo vidět, proč se trades neukládají

### Dlouhodobé řešení:
1. **Backfill z Solscan API** - pro chybějící trades
2. **Zlepšit detekci swapů** - aby se zachytily i edge cases
3. **Uložit všechny normalized trades** - i ty, které se nepodařilo zpracovat, pro pozdější analýzu

