# QuickNode Streams Filter Setup

Tento dokument popisuje, jak nastavit QuickNode Streams filter, aby posílal jen swapy pro konkrétní token páry.

## Problém

QuickNode webhook posílá všechny transakce na blockchainu, což způsobuje:
- 50 000+ requests za den
- Zpracování nepotřebných transakcí
- Zbytečné náklady na API kredity

## Řešení: QuickNode Streams Filter

QuickNode Streams umožňuje filtrovat transakce přímo na jejich straně pomocí JavaScript funkce. Na server dorazí jen relevantní transakce.

## Krok 1: Získání mint adres

Nejdřív potřebuješ mint adresy tokenů, které chceš sledovat:

```bash
# TROLL token mint address (najdi na Solscan nebo DexScreener)
# TRUMP token mint address (najdi na Solscan nebo DexScreener)
```

## Krok 2: Výběr typu filtru

Máš 3 možnosti:

### Varianta A: Filter podle token párů (TROLL/SOL, TRUMP/USDC)

1. Otevři soubor `quicknode-streams-filter.js`
2. Nahraď `YOUR_TROLL_MINT_ADDRESS_HERE` skutečnou TROLL mint adresou
3. Nahraď `YOUR_TRUMP_MINT_ADDRESS_HERE` skutečnou TRUMP mint adresou
4. Pokud chceš sledovat další token páry, přidej je do `TARGET_PAIRS` pole

### Varianta B: Filter podle tracked wallets (doporučeno)

Tato varianta posílá všechny swapy pro tracked wallets (z `wallets.csv`):

1. Spusť skript pro generování filtru:
   ```bash
   ./generate-quicknode-filter.sh
   ```
2. Tím se vytvoří `quicknode-streams-filter-generated.js` s všemi adresami z `wallets.csv`
3. Použij tento vygenerovaný soubor v QuickNode Dashboard

### Varianta C: Ruční filter podle tracked wallets

1. Otevři soubor `quicknode-streams-filter-wallets.js`
2. Nahraď `TRACKED_WALLETS` pole skutečnými adresami z `wallets.csv`

## Krok 3: Nastavení v QuickNode Dashboard

1. Jdi do [QuickNode Dashboard](https://dashboard.quicknode.com/)
2. Vyber svůj endpoint
3. Jdi na **Streams** (nebo **QuickAlerts**)
4. Vytvoř nový Stream nebo uprav existující
5. V sekci **Filter Function** vlož kód z `quicknode-streams-filter.js`
6. Nastav **Webhook URL** na: `https://tradooor.stepanpanek.cz/api/webhooks/quicknode`
7. Ulož změny

## Krok 4: Testování

Po nastavení filtru by měl QuickNode posílat jen swapy, které:
- Volají DEX program (Jupiter, Raydium, Orca, Pump.fun)
- Obsahují oba minty z páru (např. TROLL + WSOL, TRUMP + USDC)

Sleduj logy backendu:
```bash
pm2 logs tradooor-backend --lines 0
```

Mělo by být vidět:
- Méně webhook requests
- Jen relevantní swapy v logách
- Úspěšné ukládání tradeů do databáze

## Podporované DEX programy

- **Jupiter v6 aggregator**: `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`
- **Raydium AMM v4**: `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`
- **Orca Whirlpools**: `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`
- **Pump.fun**: `pump9xNzDDnyWJ1cg9CHG9g9o6CWGt77CajND4xqJcf`

## Podporované base tokeny

- **WSOL (SOL)**: `So11111111111111111111111111111111111111112`
- **USDC**: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- **USDT**: `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` (můžeš přidat)

## Přidání dalších token párů

Chceš sledovat další token páry? Uprav `TARGET_PAIRS` v `quicknode-streams-filter.js`:

```javascript
const TARGET_PAIRS = [
  {
    token1: 'TROLL',
    token1Mint: 'YOUR_TROLL_MINT_ADDRESS',
    token2: 'SOL',
    token2Mint: 'So11111111111111111111111111111111111111112',
  },
  {
    token1: 'TRUMP',
    token1Mint: 'YOUR_TRUMP_MINT_ADDRESS',
    token2: 'USDC',
    token2Mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },
  // Přidej další páry zde
  {
    token1: 'BONK',
    token1Mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    token2: 'SOL',
    token2Mint: 'So11111111111111111111111111111111111111112',
  },
];
```

## Troubleshooting

### Webhook stále posílá všechny transakce

- Zkontroluj, jestli je filter funkce správně uložená v QuickNode Dashboard
- Zkontroluj, jestli jsou mint adresy správné (case-sensitive)
- Zkontroluj QuickNode logs v dashboardu

### Webhook neposílá žádné transakce

- Zkontroluj, jestli jsou mint adresy správné
- Zkontroluj, jestli token páry skutečně existují na blockchainu
- Zkontroluj, jestli swapy používají podporované DEX programy

### Chyby v QuickNode Dashboard

- Zkontroluj syntax JavaScript kódu
- Ujisti se, že všechny proměnné jsou definované
- Zkontroluj QuickNode dokumentaci pro Streams filter funkce

