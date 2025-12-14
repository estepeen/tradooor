// Use /api for local development (Next.js rewrite) or if NEXT_PUBLIC_API_URL is not set
// Only use absolute URL if explicitly set and not running on localhost
export const getApiBaseUrl = () => {
  const envUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!envUrl) return '/api';
  
  // If running on localhost, always use /api (Next.js rewrite)
  if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
    return '/api';
  }
  
  return envUrl;
};

const API_BASE_URL = getApiBaseUrl();

export async function fetchSmartWallets(params?: {
  page?: number;
  pageSize?: number;
  minScore?: number;
  tags?: string[];
  search?: string;
  sortBy?: 'score' | 'winRate' | 'recentPnl30dUsd' | 'recentPnl30dPercent' | 'totalTrades' | 'lastTradeTimestamp' | 'label' | 'address';
  sortOrder?: 'asc' | 'desc';
}) {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set('page', params.page.toString());
  if (params?.pageSize) searchParams.set('pageSize', params.pageSize.toString());
  if (params?.minScore) searchParams.set('minScore', params.minScore.toString());
  if (params?.tags) searchParams.set('tags', params.tags.join(','));
  if (params?.search) searchParams.set('search', params.search);
  if (params?.sortBy) searchParams.set('sortBy', params.sortBy);
  if (params?.sortOrder) searchParams.set('sortOrder', params.sortOrder);

  const url = `${API_BASE_URL}/smart-wallets${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;
  // Add cache-busting for data update on refresh
  const res = await fetch(url, {
    cache: 'no-store', // Vždy načti aktuální data
    headers: {
      'Cache-Control': 'no-cache',
    },
  });
  if (!res.ok) throw new Error('Failed to fetch smart wallets');
  return res.json();
}

export async function fetchSmartWallet(id: string) {
  const res = await fetch(`${API_BASE_URL}/smart-wallets/${id}`, {
    cache: 'no-store', // Vždy načti aktuální data
    headers: {
      'Cache-Control': 'no-cache',
    },
  });
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error('Wallet not found');
    }
    throw new Error(`Failed to fetch smart wallet: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function fetchTrades(walletId: string, params?: {
  page?: number;
  pageSize?: number;
  tokenId?: string;
  fromDate?: string;
  toDate?: string;
}) {
  const searchParams = new URLSearchParams({ walletId });
  if (params?.page) searchParams.set('page', params.page.toString());
  if (params?.pageSize) searchParams.set('pageSize', params.pageSize.toString());
  if (params?.tokenId) searchParams.set('tokenId', params.tokenId);
  if (params?.fromDate) searchParams.set('fromDate', params.fromDate);
  if (params?.toDate) searchParams.set('toDate', params.toDate);

  const url = `${API_BASE_URL}/trades?${searchParams.toString()}`;
  const res = await fetch(url, {
    cache: 'no-store', // Vždy načti aktuální data
    headers: {
      'Cache-Control': 'no-cache',
    },
  });
  if (!res.ok) throw new Error('Failed to fetch trades');
  return res.json();
}

export async function fetchStatsOverview() {
  const res = await fetch(`${API_BASE_URL}/stats/overview`);
  if (!res.ok) throw new Error('Failed to fetch stats overview');
  return res.json();
}

export async function fetchTokenStats(period: '1d' | '7d' | '14d' | '30d' | 'all-time' = 'all-time') {
  const url = `${API_BASE_URL}/stats/tokens${period ? `?period=${period}` : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch token stats');
  return res.json();
}

export async function fetchDexStats() {
  const res = await fetch(`${API_BASE_URL}/stats/dex`);
  if (!res.ok) throw new Error('Failed to fetch DEX stats');
  return res.json();
}

export async function fetchWalletPnl(walletId: string) {
  const res = await fetch(`${API_BASE_URL}/smart-wallets/${walletId}/pnl`);
  if (!res.ok) throw new Error('Failed to fetch wallet PnL');
  return res.json();
}

export async function fetchWalletPortfolio(walletId: string, forceRefresh: boolean = false) {
  const url = `${API_BASE_URL}/smart-wallets/${walletId}/portfolio${forceRefresh ? '?forceRefresh=true' : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch wallet portfolio');
  return res.json();
}

export async function fetchWalletPortfolioRefresh(walletId: string) {
  const url = `${API_BASE_URL}/smart-wallets/${walletId}/portfolio/refresh`;
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!res.ok) {
    let msg = 'Failed to refresh wallet portfolio';
    try {
      const body = await res.json();
      if (body?.message) msg = `Solscan error: ${body.message}`;
      else if (body?.error) msg = body.error;
    } catch {
      try {
        const text = await res.text();
        if (text) msg = text;
      } catch {}
    }
    throw new Error(msg);
  }
  return res.json();
}

export async function fetchRecentTrades(params?: {
  limit?: number;
  since?: string;
}) {
  const searchParams = new URLSearchParams();
  if (params?.limit) searchParams.set('limit', params.limit.toString());
  if (params?.since) searchParams.set('since', params.since);

  const url = `${API_BASE_URL}/trades/recent${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!res.ok) throw new Error('Failed to fetch recent trades');
  return res.json();
}

export async function deletePosition(walletId: string, tokenId: string, sequenceNumber?: number) {
  const url = `${API_BASE_URL}/smart-wallets/${walletId}/positions/${tokenId}${sequenceNumber !== undefined ? `?sequenceNumber=${sequenceNumber}` : ''}`;
  const res = await fetch(url, {
    method: 'DELETE',
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Failed to delete position' }));
    throw new Error(error.error || error.message || 'Failed to delete position');
  }
  return res.json();
}

// Paper Trading API
export async function fetchPaperTradingPortfolio() {
  const res = await fetch(`${API_BASE_URL}/paper-trading/portfolio`, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!res.ok) throw new Error('Failed to fetch paper trading portfolio');
  return res.json();
}

export async function fetchPaperTrades(params?: {
  walletId?: string;
  status?: 'open' | 'closed' | 'cancelled';
  limit?: number;
}) {
  const searchParams = new URLSearchParams();
  if (params?.walletId) searchParams.set('walletId', params.walletId);
  if (params?.status) searchParams.set('status', params.status);
  if (params?.limit) searchParams.set('limit', params.limit.toString());

  const url = `${API_BASE_URL}/paper-trading/trades${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!res.ok) throw new Error('Failed to fetch paper trades');
  return res.json();
}

export async function fetchPaperPortfolioHistory(limit?: number) {
  const url = `${API_BASE_URL}/paper-trading/portfolio/history${limit ? `?limit=${limit}` : ''}`;
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!res.ok) throw new Error('Failed to fetch portfolio history');
  return res.json();
}

export async function copyTradeAsPaperTrade(tradeId: string, config?: any) {
  const res = await fetch(`${API_BASE_URL}/paper-trading/copy-trade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tradeId, config }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Failed to copy trade' }));
    throw new Error(error.error || error.message || 'Failed to copy trade');
  }
  return res.json();
}

export async function fetchConsensusTrades(hours?: number) {
  const url = `${API_BASE_URL}/paper-trading/consensus-trades${hours ? `?hours=${hours}` : ''}`;
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!res.ok) throw new Error('Failed to fetch consensus trades');
  return res.json();
}

export async function fetchConsensusSignals(limit?: number) {
  const searchParams = new URLSearchParams();
  if (limit) searchParams.set('limit', limit.toString());

  const url = `${API_BASE_URL}/trades/consensus-signals${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!res.ok) throw new Error('Failed to fetch consensus signals');
  return res.json();
}

export async function fetchSignals(options?: { type?: 'buy' | 'sell'; limit?: number }) {
  const params = new URLSearchParams();
  if (options?.type) params.append('type', options.type);
  if (options?.limit) params.append('limit', options.limit.toString());
  const url = `${API_BASE_URL}/signals${params.toString() ? `?${params.toString()}` : ''}`;
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!res.ok) throw new Error('Failed to fetch signals');
  return res.json();
}

export async function generateSignal(tradeId: string, config?: any) {
  const res = await fetch(`${API_BASE_URL}/signals/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tradeId, config }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Failed to generate signal' }));
    throw new Error(error.error || error.message || 'Failed to generate signal');
  }
  return res.json();
}

export async function fetchConsensusNotifications(params?: {
  hours?: number;
  limit?: number;
}) {
  const searchParams = new URLSearchParams();
  if (params?.hours) searchParams.set('hours', params.hours.toString());
  if (params?.limit) searchParams.set('limit', params.limit.toString());

  const url = `${API_BASE_URL}/trades/consensus-notifications${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!res.ok) throw new Error('Failed to fetch consensus notifications');
  return res.json();
}

export async function recalculateWalletClosedPositions(walletId: string) {
  const res = await fetch(`${API_BASE_URL}/smart-wallets/${walletId}/recalculate-closed-positions`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Failed to recalculate closed positions' }));
    throw new Error(error.error || error.message || 'Failed to recalculate closed positions');
  }
  return res.json();
}

