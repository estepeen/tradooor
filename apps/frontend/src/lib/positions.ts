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
export function computePositionMetricsFromPercent(
  trades: Array<{ id: string; tokenId: string; positionChangePercent?: number | null; timestamp: Date | string | number }>
): Record<string, PositionMetric> {
  if (!trades.length) {
    return {};
  }

  const result: Record<string, PositionMetric> = {};
  const state = new Map<string, number>(); // current multiplier per token

  const sorted = [...trades].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  for (const trade of sorted) {
    const tokenId = trade.tokenId;
    const percent = Number(trade.positionChangePercent ?? 0);
    const current = state.get(tokenId) ?? 0;

    let action: PositionAction = 'NONE';
    let deltaX = 0;
    let beforeX = current;

    if (percent >= 99) {
      // Plné otevření nové pozice
      action = 'BUY';
      beforeX = 0;
      deltaX = 1;
    } else if (percent > 0) {
      action = 'ADD';
      deltaX = percent / 100;
    } else if (percent <= -99) {
      action = 'SELL';
      deltaX = current !== 0 ? -current : -1;
    } else if (percent < 0) {
      action = 'REM';
      deltaX = percent / 100;
    } else {
      action = 'NONE';
      deltaX = 0;
    }

    const afterX =
      action === 'SELL' ? Math.max(current + deltaX, 0) : Math.max(beforeX + deltaX, 0);

    result[trade.id] = {
      positionXBefore: beforeX,
      positionXAfter: afterX,
      deltaX,
      action,
    };

    if (action === 'SELL') {
      state.set(tokenId, 0);
    } else {
      state.set(tokenId, afterX);
    }
  }

  return result;
}


