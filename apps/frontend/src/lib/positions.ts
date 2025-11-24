export type TradeSide = 'buy' | 'sell' | 'add' | 'remove';
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
  trades: Array<{
    id: string;
    tokenId: string;
    positionChangePercent?: number | null;
    timestamp: Date | string | number;
    side?: TradeSide | null;
  }>
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
    const changeMultiplier = percent / 100;

    let action: PositionAction = 'NONE';
    let beforeX = current;
    let afterX = current;

    const side = trade.side;

    const applyRelativeChange = () => {
      const next = current * (1 + changeMultiplier);
      return Number.isFinite(next) ? Math.max(next, 0) : Math.max(current + changeMultiplier, 0);
    };

    if (side === 'buy') {
      action = 'BUY';
      beforeX = 0;
      afterX = 1;
    } else if (side === 'add') {
      action = 'ADD';
      beforeX = current;
      afterX = applyRelativeChange();
    } else if (side === 'sell') {
      action = 'SELL';
      beforeX = current;
      afterX = 0;
    } else if (side === 'remove') {
      action = 'REM';
      beforeX = current;
      afterX = applyRelativeChange();
    } else {
      // Fallback heuristiky, pokud side není k dispozici (starší data)
      if (percent >= 99) {
        action = 'BUY';
        beforeX = 0;
        afterX = 1;
      } else if (percent > 0) {
        action = 'ADD';
        beforeX = current;
        afterX = Math.max(current + changeMultiplier, 0);
      } else if (percent <= -99) {
        action = 'SELL';
        beforeX = current;
        afterX = 0;
      } else if (percent < 0) {
        action = 'REM';
        beforeX = current;
        afterX = Math.max(current + changeMultiplier, 0);
      }
    }

    const deltaX = afterX - beforeX;

    result[trade.id] = {
      positionXBefore: beforeX,
      positionXAfter: afterX,
      deltaX,
      action,
    };

    state.set(tokenId, afterX);
  }

  return result;
}


