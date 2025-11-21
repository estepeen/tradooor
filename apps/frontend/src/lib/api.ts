const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

export async function fetchSmartWallets(params?: {
  page?: number;
  pageSize?: number;
  minScore?: number;
  tags?: string[];
  search?: string;
  sortBy?: 'score' | 'winRate' | 'recentPnl30dPercent' | 'totalTrades' | 'lastTradeTimestamp' | 'label' | 'address';
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
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch trades');
  return res.json();
}

export async function fetchStatsOverview() {
  const res = await fetch(`${API_BASE_URL}/stats/overview`);
  if (!res.ok) throw new Error('Failed to fetch stats overview');
  return res.json();
}

export async function fetchTokenStats() {
  const res = await fetch(`${API_BASE_URL}/stats/tokens`);
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

