export type PositionAction = 'BUY' | 'ADD' | 'SELL' | 'REM' | 'NONE';

export interface PositionMetric {
  positionXBefore: number;
  positionXAfter: number;
  deltaX: number;
  action: PositionAction;
}

/**
 * Vypočítá normalizované pozice podle procentální změny pozice (`positionChangePercent`).
 * DŮLEŽITÉ: Použije positionChangePercent z databáze, pokud je k dispozici (uložený při webhooku).
 * Pokud není k dispozici, použije výpočet z amountToken jako fallback.
 */
type RawTrade = {
  id: string;
  tokenId: string;
  amountToken?: number | string | null;
  amountBase?: number | string | null; // Hodnota v SOL/USDC/USDT (důležité pro správný výpočet ratio)
  timestamp: Date | string | number;
  side?: string | null;
  positionChangePercent?: number | null; // Z databáze - uložený při webhooku
};

const EPS = 1e-9;

export function computePositionMetricsFromPercent(
  trades: RawTrade[]
): Record<string, PositionMetric> {
  if (!trades.length) return {};

  const result: Record<string, PositionMetric> = {};
  const state = new Map<
    string,
    {
      balanceTokens: number;
      totalCostBase: number; // Celkové náklady v SOL/USDC/USDT (pro správný výpočet ratio)
      positionX: number;
    }
  >();

  const sorted = [...trades].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  for (const trade of sorted) {
    const tokenId = trade.tokenId;
    const amount = Math.abs(Number(trade.amountToken ?? 0));

    if (!state.has(tokenId)) {
      state.set(tokenId, { balanceTokens: 0, totalCostBase: 0, positionX: 0 });
    }

    const entry = state.get(tokenId)!;
    // DŮLEŽITÉ: beforeX musí být aktuální pozice PŘED tímto trade
    let beforeX = entry.positionX;
    let afterX = beforeX;
    let action: PositionAction = 'NONE';

    const side = (trade.side || '').toLowerCase();
    const amountBase = Math.abs(Number(trade.amountBase ?? 0)); // Hodnota v SOL/USDC/USDT

    const resolveAction = (): PositionAction => {
      // DŮLEŽITÉ: Použij TYPE z backendu (už je správně vypočítaný na základě balance)
      // Backend už správně určuje buy/add/remove/sell, takže to necháme na něm
      if (side === 'buy') return 'BUY';
      if (side === 'add') return 'ADD';
      if (side === 'sell') return 'SELL';
      if (side === 'remove') return 'REM';
      // Fallback heuristiky pokud není side dostupný
      if (entry.balanceTokens <= EPS && amount > EPS) return 'BUY';
      return 'NONE';
    };

    const resolvedAction = resolveAction();

    // Pokud máme positionChangePercent z backendu, použijeme ho jako primární zdroj pravdy
    // pro výpočet pozice: afterX = beforeX + (positionChangePercent / 100).
    const hasPercent =
      trade.positionChangePercent !== null &&
      trade.positionChangePercent !== undefined &&
      Number.isFinite(Number(trade.positionChangePercent));

    if (hasPercent) {
      const pct = Number(trade.positionChangePercent);
      action = resolvedAction;
      beforeX = entry.positionX;
      afterX = beforeX + pct / 100;
      if (afterX < 0) afterX = 0; // bezpečnostní ořez

      // Udržuj základní stav pro potenciální budoucí fallbacky / debug
      switch (resolvedAction) {
        case 'BUY':
        case 'ADD': {
          entry.balanceTokens += amount;
          entry.totalCostBase += amountBase;
          break;
        }
        case 'SELL':
        case 'REM': {
          entry.balanceTokens = Math.max(0, entry.balanceTokens - amount);
          entry.totalCostBase = Math.max(0, entry.totalCostBase - amountBase);
          if (resolvedAction === 'SELL') {
            // Po SELL by měla být pozice nulová
            entry.balanceTokens = 0;
            entry.totalCostBase = 0;
          }
          break;
        }
        default:
          break;
      }
    } else {
      // Fallback: původní logika založená na amountBase/amountToken
      switch (resolvedAction) {
      case 'BUY': {
        action = 'BUY';
        beforeX = entry.positionX; // Aktuální pozice před BUY (obvykle 0)
        afterX = 1.0; // První nákup = 1.00x
        entry.balanceTokens = amount;
        entry.totalCostBase = amountBase; // Ulož náklady v SOL
        break;
      }
      case 'ADD': {
        action = 'ADD';
        beforeX = entry.positionX; // Aktuální pozice před ADD
        if (entry.balanceTokens <= EPS) {
          // Pokud nemáme žádnou pozici, ale dostáváme ADD (měl by to být BUY, ale použijeme ADD)
          afterX = 1.0;
          entry.balanceTokens = amount;
          entry.totalCostBase = amountBase;
        } else {
          // DŮLEŽITÉ: ratio = jaká část současných nákladů přidáváme (v SOL, ne v tokenech!)
          // Pokud přidáme stejnou hodnotu v SOL (zdvojnásobíme náklady), ratio = 1.0, takže deltaX = 1.0
          // Pokud přidáme 50% současných nákladů, ratio = 0.5, takže deltaX = 0.5
          // Příklad: totalCostBase = 1.51 SOL, amountBase = 0.26 SOL, ratio = 0.26 / 1.51 = 0.17
          // beforeX = 1.0, deltaX = 0.17, afterX = 1.17 ✅
          const ratio = entry.totalCostBase > 0 ? amountBase / entry.totalCostBase : 0;
          const deltaX = ratio; // deltaX = kolik x přidáváme (podle hodnoty v SOL)
          afterX = entry.positionX + deltaX;
          entry.balanceTokens += amount;
          entry.totalCostBase += amountBase; // Přidej náklady v SOL
        }
        break;
      }
      case 'SELL': {
        action = 'SELL';
        beforeX = entry.positionX; // Aktuální pozice před SELL
        afterX = 0; // Po SELL je pozice 0
        entry.balanceTokens = 0;
        break;
      }
      case 'REM': {
        action = 'REM';
        beforeX = entry.positionX; // Aktuální pozice před REM
        if (entry.balanceTokens <= EPS) {
          // Nemůžeme prodávat, když nemáme pozici
          afterX = 0;
          entry.balanceTokens = 0;
          entry.totalCostBase = 0;
        } else {
          // DŮLEŽITÉ: ratio = jaká část pozice se prodává (podle hodnoty v SOL, ne v tokenech!)
          // Pokud prodáme 25% hodnoty pozice v SOL, ratio = 0.25, takže afterX = positionX * (1 - 0.25) = positionX * 0.75
          // Příklad: totalCostBase = 1.51 SOL, amountBase = 0.26 SOL, ratio = 0.26 / 1.51 = 0.17
          // beforeX = 1.17, afterX = 1.17 * (1 - 0.17) = 0.97, deltaX = -0.20 ✅
          const ratio = entry.totalCostBase > 0 ? Math.min(1, amountBase / entry.totalCostBase) : Math.min(1, amount / entry.balanceTokens);
          
          // Vypočti balance po REM PŘED výpočtem afterX
          const balanceAfter = Math.max(0, entry.balanceTokens - amount);
          const costAfter = Math.max(0, entry.totalCostBase - amountBase);
          
          // Pokud po REM klesne balance na 0, pozice je 0
          if (balanceAfter <= EPS || costAfter <= EPS) {
            afterX = 0;
            entry.balanceTokens = 0;
            entry.totalCostBase = 0;
          } else {
            // Částečný prodej - pozice se sníží proporcionálně podle hodnoty v SOL
            afterX = entry.positionX * (1 - ratio);
            entry.balanceTokens = balanceAfter;
            entry.totalCostBase = costAfter;
          }
        }
        break;
      }
      default: {
        action = 'NONE';
        break;
      }
      }
    }

    const deltaX = afterX - beforeX;

    result[trade.id] = {
      positionXBefore: beforeX,
      positionXAfter: afterX,
      deltaX,
      action,
    };

    // DŮLEŽITÉ: Aktualizuj stav PŘED dalším trade
    // Toto je kritické pro správný výpočet následujících trades
    entry.positionX = afterX;
    state.set(tokenId, entry);
    
    // Debug log pro problematické případy
    if (resolvedAction === 'ADD' && Math.abs(deltaX) < 0.01 && amount > 0 && entry.balanceTokens > 0) {
      console.warn(`[POSITION DEBUG] Trade ${trade.id}: ADD with small deltaX`, {
        tokenId,
        amount,
        balanceTokens: entry.balanceTokens,
        ratio: amount / (entry.balanceTokens - amount),
        beforeX,
        afterX,
        deltaX,
      });
    }
  }

  return result;
}


