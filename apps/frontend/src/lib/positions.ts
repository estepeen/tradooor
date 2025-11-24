export type PositionAction = 'BUY' | 'ADD' | 'SELL' | 'REM' | 'NONE';

export interface PositionMetric {
  positionXBefore: number;
  positionXAfter: number;
  deltaX: number;
  action: PositionAction;
}

/**
 * Vypočítá normalizované pozice podle procentální změny pozice (`positionChangePercent`).
 * Využívá pouze percentuální data, takže funguje i když amountToken není spolehlivé.
 */
type RawTrade = {
  id: string;
  tokenId: string;
  amountToken?: number | string | null;
  timestamp: Date | string | number;
  side?: string | null;
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
      state.set(tokenId, { balanceTokens: 0, positionX: 0 });
    }

    const entry = state.get(tokenId)!;
    // DŮLEŽITÉ: beforeX musí být aktuální pozice PŘED tímto trade
    let beforeX = entry.positionX;
    let afterX = beforeX;
    let action: PositionAction = 'NONE';

    const side = (trade.side || '').toLowerCase();

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

    switch (resolvedAction) {
      case 'BUY': {
        action = 'BUY';
        beforeX = entry.positionX; // Aktuální pozice před BUY (obvykle 0)
        afterX = 1.0; // První nákup = 1.00x
        entry.balanceTokens = amount;
        break;
      }
      case 'ADD': {
        action = 'ADD';
        beforeX = entry.positionX; // Aktuální pozice před ADD
        if (entry.balanceTokens <= EPS) {
          // Pokud nemáme žádnou pozici, ale dostáváme ADD (měl by to být BUY, ale použijeme ADD)
          afterX = 1.0;
          entry.balanceTokens = amount;
        } else {
          // DŮLEŽITÉ: ratio = kolikrát větší je nový amount než současný balance
          // Pokud přidáme 10x více tokenů, ratio = 10, takže afterX = positionX * (1 + 10) = positionX * 11
          // Příklad: balanceTokens = 100, amount = 1000, ratio = 10
          // beforeX = 1.0, afterX = 1.0 * (1 + 10) = 11.0, deltaX = 10.0 ✅
          const ratio = amount / entry.balanceTokens;
          afterX = entry.positionX * (1 + ratio);
          entry.balanceTokens += amount;
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
          afterX = 0;
          entry.balanceTokens = 0;
        } else {
          // ratio = jaká část pozice se prodává (0-1)
          // Příklad: balanceTokens = 1000, amount = 100, ratio = 0.1
          // beforeX = 11.0, afterX = 11.0 * (1 - 0.1) = 9.9, deltaX = -1.1 ✅
          const ratio = Math.min(1, amount / entry.balanceTokens);
          afterX = entry.positionX * (1 - ratio);
          entry.balanceTokens = Math.max(0, entry.balanceTokens - amount);
        }
        break;
      }
      default: {
        action = 'NONE';
        break;
      }
    }

    const deltaX = afterX - beforeX;

    result[trade.id] = {
      positionXBefore: beforeX,
      positionXAfter: afterX,
      deltaX,
      action,
    };

    entry.positionX = afterX;
    state.set(tokenId, entry);
  }

  return result;
}


