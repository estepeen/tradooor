const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

export async function fetchSmartWallets(params?: {
  page?: number;
  pageSize?: number;
  minScore?: number;
  tags?: string[];
  search?: string;
  sortBy?: 'score' | 'winRate' | 'recentPnl30dPercent';
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
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch smart wallets');
  return res.json();
}

export async function fetchSmartWallet(id: string) {
  const res = await fetch(`${API_BASE_URL}/smart-wallets/${id}`);
  if (!res.ok) throw new Error('Failed to fetch smart wallet');
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

