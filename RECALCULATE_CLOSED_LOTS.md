# Problém s Closed Lots

## Co se stalo
Script `recalculate-closed-lots.ts` smazal closed lots, ale nepřepočítal je správně, což způsobilo:
- Některé wallets ukazují 0 closed positions
- PnL na detailu tradera a na homepage nesouhlasí
- Nesprávné PnL hodnoty (např. změna z -1500 USD na 19000 USD)

## Řešení
Vrátili jsme změny v `lot-matching.service.ts` zpět na původní verzi, která používá:
```typescript
const proceeds = consumed * price;
```

## Jak znovu vytvořit closed lots
Spusť původní worker pro všechny wallets:
```bash
pnpm --filter backend process:closed-lots
```

Nebo pro konkrétní wallet:
```bash
pnpm --filter backend process:closed-lots <walletId>
```

## Poznámka
Původní problém (rozdíl mezi $806.88 a $1,221.92) byl způsoben tím, že closed lots pokrývaly jen část SELL trade (tokens s matching BUY), zatímco celý SELL trade měl vyšší hodnotu. To je správné chování - closed lots ukazují jen realized PnL z trades s cost basis.

