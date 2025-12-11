# Optimalizace Backfill Cron - Snížení QuickNode Requests

## Problém
Backfill-cron spotřebovává 200+ requests za 2 hodiny, což je moc. Potřebujeme ho optimalizovat, ale zachovat funkčnost (doplňuje webhooky).

## Možnosti optimalizace

### 1. ✅ Zvýšit interval (nejjednodušší)
**Aktuálně:** každé 2 minuty (`*/2 * * * *`)
**Navrhuji:** každých 10 minut (`*/10 * * * *`)
**Úspora:** 5x méně requests (z 30x/hodinu na 6x/hodinu)

### 2. ✅ Použít Helius RPC místo QuickNode (pokud máš Helius API key)
**Výhoda:** Helius má lepší rate limits a je zdarma pro základní použití
**Změna:** `HELIUS_RPC_URL` místo `QUICKNODE_RPC_URL`

### 3. ✅ Přeskočit wallets s recent trades (webhook už to chytil)
**Logika:** Pokud má wallet trade v posledních 2 minutách, přeskočit (webhook to už zpracoval)
**Úspora:** Sníží počet RPC calls o 50-80%

### 4. ✅ Snížit limit signatures
**Aktuálně:** 50 signatures per wallet
**Navrhuji:** 20 signatures (stačí pro 2 minuty)
**Úspora:** Méně getTransaction calls

### 5. ✅ Přidat cache - ukládat poslední kontrolovaný timestamp
**Logika:** Ukládat do DB poslední kontrolovaný timestamp pro každou wallet
**Výhoda:** Kontrolovat jen od poslední kontroly, ne vždy poslední 2 minuty
**Úspora:** Výrazně méně requests pro neaktivní wallets

### 6. ✅ Batch processing s delay
**Logika:** Zpracovávat wallets v batchích po 10 s delay mezi batchi
**Výhoda:** Rovnoměrnější zatížení, méně rate limit errors

## Doporučená kombinace

**Nejlepší kombinace:**
1. Interval: 10 minut (místo 2 minut)
2. Přeskočit wallets s trades v posledních 2 minutách
3. Snížit limit na 20 signatures
4. Použít Helius RPC pokud je dostupné
5. Přidat cache pro poslední kontrolovaný timestamp

**Očekávaná úspora:**
- Z ~2400 requests/hodinu na ~200-400 requests/hodinu
- To je 6-12x méně requests!

## Implementace

Mám implementovat všechny tyto optimalizace?
