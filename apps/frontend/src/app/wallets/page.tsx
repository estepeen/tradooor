'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { fetchSmartWallets } from '@/lib/api';
import { formatAddress, formatPercent, formatNumber, formatLastTrade } from '@/lib/utils';
import type { SmartWalletListResponse } from '@solbot/shared';

export default function WalletsPage() {
  const router = useRouter();
  const [data, setData] = useState<SmartWalletListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [minScore, setMinScore] = useState<number | undefined>();
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<'score' | 'winRate' | 'recentPnl30dPercent'>('score');
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncSuccess, setSyncSuccess] = useState<{ created: number; errors: number; removed?: number } | null>(null);

  useEffect(() => {
    loadWallets();
  }, [page, search, minScore, sortBy, selectedTags]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      loadWallets();
    }, 30000); // 30 seconds

    return () => clearInterval(interval);
  }, [page, search, minScore, sortBy, selectedTags]);

  useEffect(() => {
    // Load available tags from wallets
    if (data?.wallets) {
      const tags = new Set<string>();
      data.wallets.forEach(w => {
        w.tags?.forEach(tag => tags.add(tag));
      });
      setAvailableTags(Array.from(tags).sort());
    }
  }, [data]);

  async function loadWallets() {
    setLoading(true);
    try {
      const result = await fetchSmartWallets({
        page,
        pageSize: 20,
        search: search || undefined,
        minScore,
        tags: selectedTags.length > 0 ? selectedTags : undefined,
        sortBy,
        sortOrder: 'desc',
      });
      setData(result);
    } catch (error) {
      console.error('Error loading wallets:', error);
    } finally {
      setLoading(false);
    }
  }

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    loadWallets();
  };

  if (loading && !data) {
    return (
      <div className="min-h-screen bg-background p-8">
        <div className="container mx-auto">
          <div className="text-center">Loading...</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`min-h-screen bg-background p-8 ${(syncError || syncSuccess) ? 'pt-20' : ''}`}>
      <div className="container mx-auto">
        <div className="mb-8 flex justify-between items-center">
          <div>
            <h1 className="mb-2">Smart Wallets</h1>
            <p className="text-muted-foreground">Track and analyze smart wallet performance</p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/wallets/add"
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
            >
              Add Wallet
            </Link>
            <button
              onClick={async () => {
                setSyncLoading(true);
                setSyncError(null);
                setSyncSuccess(null);

                try {
                  const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || '/api';
                  const response = await fetch(`${API_BASE_URL}/smart-wallets/sync`, {
                    method: 'POST',
                  });

                  const result = await response.json();

                  if (!response.ok) {
                    if (result.validationErrors && result.validationErrors.length > 0) {
                      const errorDetails = result.validationErrors
                        .map((e: any) => `Row ${e.row}: ${e.error} (${e.address || 'no address'})`)
                        .join('\n');
                      throw new Error(`Validation errors:\n${errorDetails}`);
                    }
                    throw new Error(result.error || 'Sync failed');
                  }

                  let validationErrorMsg = null;
                  if (result.validationErrors && result.validationErrors.length > 0) {
                    const errorDetails = result.validationErrors
                      .map((e: any) => `Row ${e.row}: ${e.error} (${e.address || 'no address'})`)
                      .join('\n');
                    validationErrorMsg = `Validation errors:\n${errorDetails}`;
                  }

                  // result.errors může být pole objektů nebo číslo - normalizujme to
                  const errorCount = Array.isArray(result.errors) 
                    ? result.errors.length 
                    : (typeof result.errors === 'number' ? result.errors : 0);
                  
                  setSyncSuccess({
                    created: Array.isArray(result.created) ? result.created.length : (result.created || 0),
                    errors: errorCount,
                  });

                  if (validationErrorMsg) {
                    setSyncError(validationErrorMsg);
                  }

                  // Reload wallets after successful sync
                  await loadWallets();
                } catch (err: any) {
                  setSyncError(err.message || 'Failed to synchronize wallets');
                } finally {
                  setSyncLoading(false);
                }
              }}
              disabled={syncLoading}
              className="px-4 py-2 border border-border rounded-md hover:bg-muted transition-colors disabled:opacity-50"
            >
              {syncLoading ? 'Syncing...' : 'Synchronize Wallets'}
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="mb-6 space-y-4">
          <div className="md:flex md:space-y-0 md:space-x-4">
            <form onSubmit={handleSearch} className="flex-1">
              <input
                type="text"
                placeholder="Search by address or label..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full px-4 py-2 border border-border rounded-md bg-background"
              />
            </form>
            <input
              type="number"
              placeholder="Min score"
              value={minScore || ''}
              onChange={(e) => setMinScore(e.target.value ? parseFloat(e.target.value) : undefined)}
              className="px-4 py-2 border border-border rounded-md bg-background w-full md:w-32"
            />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="px-4 py-2 border border-border rounded-md bg-background"
            >
              <option value="score">Sort by Score</option>
              <option value="winRate">Sort by Win Rate</option>
              <option value="recentPnl30dPercent">Sort by Recent PnL</option>
            </select>
          </div>
          
          {/* Tags filter */}
          {availableTags.length > 0 && (
            <div>
              <div className="text-sm text-muted-foreground mb-2">Filter by tags:</div>
              <div className="flex flex-wrap gap-2">
                {availableTags.map(tag => (
                  <button
                    key={tag}
                    onClick={() => {
                      setSelectedTags(prev => 
                        prev.includes(tag) 
                          ? prev.filter(t => t !== tag)
                          : [...prev, tag]
                      );
                      setPage(1);
                    }}
                    className={`px-3 py-1 rounded text-sm border transition-colors ${
                      selectedTags.includes(tag)
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background border-border hover:bg-muted'
                    }`}
                  >
                    {tag}
                  </button>
                ))}
                {selectedTags.length > 0 && (
                  <button
                    onClick={() => {
                      setSelectedTags([]);
                      setPage(1);
                    }}
                    className="px-3 py-1 rounded text-sm border border-border hover:bg-muted"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Table */}
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium">Trader</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Wallet</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">Score</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">Trades</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">Win Rate</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">Recent PnL (30d)</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">Last Trade</th>
                </tr>
              </thead>
              <tbody>
                {data?.wallets.map((wallet) => (
                  <tr
                    key={wallet.id}
                    onClick={() => {
                      router.push(`/wallet/${wallet.address}`);
                    }}
                    className="border-t border-border hover:bg-muted/50 cursor-pointer"
                  >
                    <td className="px-4 py-3 text-sm">
                      <span className="underline">
                        {wallet.label || '-'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-sm">
                        {formatAddress(wallet.address)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium">
                      {formatNumber(wallet.score, 1)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm">
                      {wallet.totalTrades}
                    </td>
                    <td className="px-4 py-3 text-right text-sm">
                      {formatPercent(wallet.winRate)}
                    </td>
                    <td className={`px-4 py-3 text-right text-sm font-medium ${
                      wallet.recentPnl30dPercent >= 0 ? 'text-green-600' : 'text-red-600'
                    }`}>
                      {wallet.recentPnl30dUsd !== undefined && wallet.recentPnl30dUsd !== null
                        ? (
                          <>
                            ${formatNumber(Math.abs(wallet.recentPnl30dUsd), 2)}{' '}
                            ({wallet.recentPnl30dPercent >= 0 ? '+' : ''}{formatPercent(wallet.recentPnl30dPercent / 100)})
                          </>
                        )
                        : `${wallet.recentPnl30dPercent >= 0 ? '+' : ''}${formatPercent(wallet.recentPnl30dPercent / 100)}`
                      }
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-muted-foreground">
                      {formatLastTrade(wallet.lastTradeTimestamp)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Pagination */}
        {data && data.total > data.pageSize && (
          <div className="mt-6 flex justify-center items-center space-x-4">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-4 py-2 border border-border rounded-md disabled:opacity-50"
            >
              Previous
            </button>
            <span className="text-sm text-muted-foreground">
              Page {page} of {Math.ceil(data.total / data.pageSize)}
            </span>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={page >= Math.ceil(data.total / data.pageSize)}
              className="px-4 py-2 border border-border rounded-md disabled:opacity-50"
            >
              Next
            </button>
          </div>
        )}

        {data && data.wallets.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            No wallets found. Add some wallets to start tracking.
          </div>
        )}

        {/* Sync Status Messages - Fixed at top */}
        {syncError && (
          <div className={`fixed top-0 left-0 right-0 z-50 p-3 rounded-b text-sm ${
            syncError.includes('Validation errors') 
              ? 'bg-yellow-950/95 border-b border-yellow-500/50 text-yellow-400'
              : 'bg-red-950/95 border-b border-red-500/50 text-red-400'
          }`}>
            <div className="container mx-auto max-w-7xl flex items-start justify-between gap-4">
              <div className="flex-1">
                {syncError.includes('Validation errors') ? (
                  <>
                    <p className="font-semibold mb-2">Some rows had validation errors:</p>
                    <pre className="text-xs whitespace-pre-wrap max-h-40 overflow-y-auto">
                      {syncError}
                    </pre>
                    <p className="mt-2 text-xs">Valid wallets were still imported.</p>
                  </>
                ) : (
                  syncError
                )}
              </div>
              <button
                onClick={() => setSyncError(null)}
                className="text-current opacity-70 hover:opacity-100"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {syncSuccess && (
          <div className="fixed top-0 left-0 right-0 z-50 p-3 bg-green-950/95 border-b border-green-500/50 text-green-400 rounded-b text-sm">
            <div className="container mx-auto max-w-7xl flex items-center justify-between gap-4">
              <div>
                Synchronization successful! 
                {syncSuccess.created > 0 && ` Created: ${syncSuccess.created}`}
                {syncSuccess.errors > 0 && ` Errors: ${syncSuccess.errors}`}
                {syncSuccess.removed && syncSuccess.removed > 0 && ` Removed: ${syncSuccess.removed}`}
              </div>
              <button
                onClick={() => setSyncSuccess(null)}
                className="text-current opacity-70 hover:opacity-100"
              >
                ✕
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

