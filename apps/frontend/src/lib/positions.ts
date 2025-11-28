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
          // DŮLEŽITÉ: Vždy počítáme z amountToken a balanceTokens, protože to je spolehlivější
          // ratio = kolikrát větší je nový amount než současný balance
          // Pokud přidáme stejné množství (zdvojnásobíme), ratio = 1.0, takže afterX = positionX * (1 + 1.0) = positionX * 2.0
          // Příklad: balanceTokens = 1000, amount = 1000, ratio = 1.0
          // beforeX = 1.0, afterX = 1.0 * (1 + 1.0) = 2.0, deltaX = 1.0 ✅
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
          // DŮLEŽITÉ: Vždy počítáme z amountToken a balanceTokens, protože to je spolehlivější
          // ratio = jaká část pozice se prodává (0-1)
          // Pokud prodáme 25% pozice, ratio = 0.25, takže afterX = positionX * (1 - 0.25) = positionX * 0.75
          // Příklad: balanceTokens = 1000, amount = 250, ratio = 0.25
          // beforeX = 2.0, afterX = 2.0 * (1 - 0.25) = 1.5, deltaX = -0.5 ✅
          const ratio = Math.min(1, amount / entry.balanceTokens);
          afterX = entry.positionX * (1 - ratio);
          entry.balanceTokens = Math.max(0, entry.balanceTokens - amount);
          
          // DŮLEŽITÉ: Pokud po REM klesne balance na 0 (nebo velmi blízko 0), afterX musí být 0
          // To zajišťuje, že když prodáme všechno, pozice je 0
          if (entry.balanceTokens <= EPS) {
            afterX = 0;
          }
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


