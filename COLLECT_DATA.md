# Jak sbírat a zobrazovat data

## Krok 1: Backfill historických dat

Spusť backfill pro všechny wallets, aby se naplnila databáze trades:

```bash
# Backfill pro všechny wallets (500 transakcí na wallet)
pnpm --filter backend collector:backfill-all 500
```

**Poznámka:** Toto může trvat dlouho (podle počtu wallets). Můžeš to nechat běžet přes noc.

Pro menší test:
```bash
# Backfill jen pro jednu wallet
pnpm --filter backend collector:backfill WALLET_ADDRESS 500
```

## Krok 2: Přepočet metrik

Po backfillu spusť přepočet metrik, aby se propisovaly do tabulky:

```bash
# Přepočet metrik pro všechny wallets
pnpm --filter backend calculate-metrics
```

## Krok 3: Spuštění nepřetržitého collectoru

Pro sledování nových transakcí:

```bash
# Spustit collector (běží na pozadí)
pnpm --filter backend collector:start
```

## Krok 4: Periodický přepočet metrik

Pro automatický přepočet metrik každých 6 hodin:

```bash
# Spustit cron job pro metriky
pnpm --filter backend metrics:cron
```

## Kontrola, že to funguje

```bash
# Zkontroluj počet trades
curl http://localhost:3001/api/trades | python3 -c "import sys, json; data = json.load(sys.stdin); print(f'Total trades: {data.get(\"total\", 0)}')"

# Zkontroluj metriky wallet
curl http://localhost:3001/api/smart-wallets | python3 -c "import sys, json; data = json.load(sys.stdin); wallets = data.get('wallets', []); print(f'Total wallets: {len(wallets)}'); [print(f'  {w.get(\"label\", \"\")}: {w.get(\"totalTrades\", 0)} trades, score: {w.get(\"score\", 0)}') for w in wallets[:5]]"
```

## Spuštění na pozadí

Pro dlouhodobé běžení:

```bash
# Backfill na pozadí
nohup pnpm --filter backend collector:backfill-all 500 > collector-backfill.log 2>&1 &

# Collector na pozadí
nohup pnpm --filter backend collector:start > collector.log 2>&1 &

# Metriky cron na pozadí
nohup pnpm --filter backend metrics:cron > metrics-cron.log 2>&1 &
```

## Kontrola logů

```bash
# Zobrazit logy backfillu
tail -f collector-backfill.log

# Zobrazit logy collectoru
tail -f collector.log

# Zobrazit logy metrik
tail -f metrics-cron.log
```

