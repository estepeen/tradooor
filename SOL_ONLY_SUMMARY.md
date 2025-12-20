# SOL-Only Implementation Summary

## ✅ Co je nyní v SOL (ne v USD)

### Backend
1. **PnL výpočty** - všechny hodnoty jsou v SOL
   - `realizedPnl` v `ClosedLot` - v SOL
   - `recentPnl30dUsd` v `SmartWallet` - obsahuje SOL hodnoty (název sloupce je historický)
   - `pnlTotalBase` v `SmartWallet` - v SOL

2. **Lot Matching Service** (`lot-matching.service.ts`)
   - `realizedPnl` - vždy v SOL
   - USDC/USDT trades se převádějí na SOL při výpočtu pomocí `BinancePriceService.getSolPriceAtTimestamp()`
   - `realizedPnlUsd` je nastaveno na `null` (už se nepočítá)

3. **Metrics Calculator** (`metrics-calculator.service.ts`)
   - `recentPnl30dUsd` - obsahuje SOL hodnoty
   - Všechny PnL výpočty jsou v SOL

4. **API Endpoints**
   - `/api/smart-wallets/:id/pnl` - vrací `pnl` a `pnlUsd` (oba obsahují SOL hodnoty)
   - `/api/smart-wallets/:id/portfolio` - vrací `realizedPnlUsd`, `closedPnlUsd` (obsahují SOL hodnoty)

### Frontend
1. **Zobrazení PnL** - všechny hodnoty zobrazují "SOL" místo "$"
   - Wallet detail page - PnL karty, closed positions, token stats
   - Homepage - PnL hodnoty
   - Stats page - total PnL, token PnL

## ⚠️ Co stále obsahuje "USD" v názvu (ale obsahuje SOL hodnoty)

Tyto názvy jsou zachovány pro **kompatibilitu s frontendem**, ale hodnoty v nich jsou v SOL:

- `pnlUsd` - obsahuje SOL hodnoty
- `realizedPnlUsd` - obsahuje SOL hodnoty  
- `closedPnlUsd` - obsahuje SOL hodnoty
- `recentPnl30dUsd` - obsahuje SOL hodnoty (název sloupce v DB)

**Důvod:** Frontend očekává tyto názvy polí, takže je zachováváme, ale hodnoty jsou v SOL.

## 🔄 Co se stále používá z historických dat

1. **`valueUsd` sloupec v `Trade` tabulce**
   - Toto je historická data z minulosti
   - Používá se pro zobrazení aktuální hodnoty pozice (portfolio)
   - NEPOUŽÍVÁ se pro výpočet PnL

2. **`amountBase` sloupec v `Trade` tabulce**
   - Obsahuje hodnotu v SOL nebo USDC/USDT (podle base tokenu)
   - Používá se pro výpočet volume
   - Pro PnL se převádí na SOL v `lot-matching.service.ts`

## ❌ Co bylo odstraněno

1. **`tradeUsdRatioMap`** - už se nevytváří
2. **`convertBaseToUsd` funkce** - odstraněna
3. **USD konverze v portfolio endpointu** - odstraněny
4. **USD konverze v PnL endpointu** - odstraněny

## 📝 Poznámky

- USDC/USDT trades se převádějí na SOL pomocí `BinancePriceService.getSolPriceAtTimestamp()` při výpočtu PnL
- Volume se počítá z `amountBase` (může být v SOL nebo USDC/USDT, ale to je OK pro zobrazení)
- Všechny PnL hodnoty jsou v SOL, včetně procent (ROI je v %)

