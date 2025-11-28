'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { fetchSmartWallets, getApiBaseUrl } from '@/lib/api';
import { formatAddress, formatPercent, formatNumber, formatLastTrade } from '@/lib/utils';
import type { SmartWalletListResponse } from '@solbot/shared';

const TAG_TOOLTIPS: Record<string, string> = {
  scalper: 'Scalper: dělá hodně krátkodobých tradeů s velmi krátkou dobou držení.',
  'high-risk': 'High-risk: velké drawdowny a agresivní risk profil.',
  degen: 'Degen: často traduje low-liquidity a rizikové tokeny.',
  sniper: 'Sniper: vstupuje velmi brzy po launchi nových tokenů.',
  'swing-trader': 'Swing trader: drží pozice delší dobu (dny až týdny).',
  'copy-trader': 'Copy trader: často vstupuje do tokenů, které předtím nakoupili jiní smart tradeři.',
  'early-adopter': 'Early adopter: rád nakupuje velmi nové tokeny krátce po launchi.',
  'momentum-trader': 'Momentum trader: vstupuje do tokenů s výrazným cenovým pohybem.',
  'extreme-risk': 'Extreme risk: extrémní drawdowny, velmi agresivní risk profil.',
  'high-frequency': 'High-frequency: dělá velké množství tradeů denně.',
  conviction: 'Conviction: obchoduje méně, ale ve větších pozicích a s vysokým win rate (10+ closed trades).',
};

const SCORE_TOOLTIPS: Record<string, string> = {
  P: 'Profitability (P): jak ziskové jsou obchody (realizovaný PnL, ROI).',
  C: 'Consistency (C): jak konzistentní jsou výsledky (win rate, stabilita).',
  R: 'Risk (R): řízení rizika, drawdowny a velikost ztrát.',
  B: 'Behaviour (B): kvalita chování – likvidita, nové tokeny, zdravost stylu.',
  SF: 'Sample factor (SF): kolik dat máme. 1.0 = hodně tradeů, 0 = málo dat.',
};

const getTagTooltip = (tag: string) =>
  TAG_TOOLTIPS[tag.toLowerCase()] || 'User-defined tag pro kategorizaci tradera.';

export default function Home() {
  const router = useRouter();
  const [data, setData] = useState<SmartWalletListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [minScore, setMinScore] = useState<number | undefined>();
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<'score' | 'winRate' | 'recentPnl30dUsd' | 'recentPnl30dPercent' | 'totalTrades' | 'lastTradeTimestamp' | 'label' | 'address'>('score');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncSuccess, setSyncSuccess] = useState<{ created: number; errors: number; removed?: number } | null>(null);

  useEffect(() => {
    loadWallets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, search, minScore, sortBy, sortOrder, selectedTags]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      loadWallets();
    }, 30000); // 30 seconds

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, search, minScore, sortBy, sortOrder, selectedTags]);

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
        sortOrder,
      });
      
      // DEBUG: Log PnL values from API (always log for debugging)
      if (result.wallets) {
        console.log(`📊 [Homepage] Received ${result.wallets.length} wallets from API`);
        result.wallets.forEach((wallet: any) => {
          console.log(`   💰 Wallet ${wallet.address}: recentPnl30dUsd=${wallet.recentPnl30dUsd}, recentPnl30dPercent=${wallet.recentPnl30dPercent}, hasValue=${wallet.recentPnl30dUsd !== undefined && wallet.recentPnl30dUsd !== null}`);
        });
      }
      
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
                  const API_BASE_URL = getApiBaseUrl();
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
                  <th 
                    className="px-4 py-3 text-left text-sm font-medium cursor-pointer hover:bg-muted/80 select-none"
                    onClick={() => {
                      if (sortBy === 'label') {
                        setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                      } else {
                        setSortBy('label');
                        setSortOrder('asc');
                      }
                    }}
                  >
                    <div className="flex items-center gap-2">
                      Trader
                      {sortBy === 'label' && (
                        <span className="text-xs">{sortOrder === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </div>
                  </th>
                  <th 
                    className="px-4 py-3 text-left text-sm font-medium cursor-pointer hover:bg-muted/80 select-none"
                    onClick={() => {
                      if (sortBy === 'address') {
                        setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                      } else {
                        setSortBy('address');
                        setSortOrder('asc');
                      }
                    }}
                  >
                    <div className="flex items-center gap-2">
                      Wallet
                      {sortBy === 'address' && (
                        <span className="text-xs">{sortOrder === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </div>
                  </th>
                  <th 
                    className="px-4 py-3 text-right text-sm font-medium cursor-pointer hover:bg-muted/80 select-none"
                    onClick={() => {
                      if (sortBy === 'score') {
                        setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                      } else {
                        setSortBy('score');
                        setSortOrder('desc');
                      }
                    }}
                  >
                    <div className="flex items-center justify-end gap-2">
                      Score
                      {sortBy === 'score' && (
                        <span className="text-xs">{sortOrder === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </div>
                  </th>
                  <th 
                    className="px-4 py-3 text-right text-sm font-medium cursor-pointer hover:bg-muted/80 select-none"
                    onClick={() => {
                      if (sortBy === 'totalTrades') {
                        setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                      } else {
                        setSortBy('totalTrades');
                        setSortOrder('desc');
                      }
                    }}
                  >
                    <div className="flex items-center justify-end gap-2">
                      Trades
                      {sortBy === 'totalTrades' && (
                        <span className="text-xs">{sortOrder === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </div>
                  </th>
                  <th 
                    className="px-4 py-3 text-right text-sm font-medium cursor-pointer hover:bg-muted/80 select-none"
                    onClick={() => {
                      if (sortBy === 'winRate') {
                        setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                      } else {
                        setSortBy('winRate');
                        setSortOrder('desc');
                      }
                    }}
                  >
                    <div className="flex items-center justify-end gap-2">
                      Win Rate
                      {sortBy === 'winRate' && (
                        <span className="text-xs">{sortOrder === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </div>
                  </th>
                  <th 
                    className="px-4 py-3 text-right text-sm font-medium cursor-pointer hover:bg-muted/80 select-none"
                    onClick={() => {
                      if (sortBy === 'recentPnl30dUsd') {
                        setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                      } else {
                        setSortBy('recentPnl30dUsd');
                        setSortOrder('desc');
                      }
                    }}
                  >
                    <div className="flex items-center justify-end gap-2">
                      Recent PnL (30d)
                      {sortBy === 'recentPnl30dUsd' && (
                        <span className="text-xs">{sortOrder === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </div>
                  </th>
                  <th 
                    className="px-4 py-3 text-right text-sm font-medium cursor-pointer hover:bg-muted/80 select-none"
                    onClick={() => {
                      if (sortBy === 'lastTradeTimestamp') {
                        setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                      } else {
                        setSortBy('lastTradeTimestamp');
                        setSortOrder('desc');
                      }
                    }}
                  >
                    <div className="flex items-center justify-end gap-2">
                      Last Trade
                      {sortBy === 'lastTradeTimestamp' && (
                        <span className="text-xs">{sortOrder === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data?.wallets
                  .sort((a, b) => {
                    // Client-side sorting for fields that are calculated after DB query
                    if (sortBy === 'lastTradeTimestamp') {
                      const aTime = a.lastTradeTimestamp ? new Date(a.lastTradeTimestamp).getTime() : 0;
                      const bTime = b.lastTradeTimestamp ? new Date(b.lastTradeTimestamp).getTime() : 0;
                      // Treat null/undefined as 0 (oldest)
                      const aVal = aTime || 0;
                      const bVal = bTime || 0;
                      return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
                    }
                    if (sortBy === 'recentPnl30dUsd') {
                      // Use advancedStats.rolling['30d'] if available (same as detail page), otherwise fallback to recentPnl30dUsd
                      const getPnlUsd = (w: any) => {
                        const rolling30d = w.advancedStats?.rolling?.['30d'];
                        return rolling30d?.realizedPnlUsd ?? w.recentPnl30dUsd ?? 0;
                      };
                      const aPnl = getPnlUsd(a);
                      const bPnl = getPnlUsd(b);
                      // DEBUG: Log sorting values
                      if (process.env.NODE_ENV === 'development' && Math.abs(aPnl) > 100 || Math.abs(bPnl) > 100) {
                        console.log(`🔍 [Sort] ${a.address}: ${aPnl}, ${b.address}: ${bPnl}, order: ${sortOrder}`);
                      }
                      return sortOrder === 'asc' ? aPnl - bPnl : bPnl - aPnl;
                    }
                    if (sortBy === 'recentPnl30dPercent') {
                      // Use advancedStats.rolling['30d'] if available (same as detail page), otherwise fallback to recentPnl30dPercent
                      const getPnlPercent = (w: any) => {
                        const rolling30d = w.advancedStats?.rolling?.['30d'];
                        return rolling30d?.realizedRoiPercent ?? w.recentPnl30dPercent ?? 0;
                      };
                      const aPnl = getPnlPercent(a);
                      const bPnl = getPnlPercent(b);
                      return sortOrder === 'asc' ? aPnl - bPnl : bPnl - aPnl;
                    }
                    // Other fields are sorted by backend, but we still need to maintain order
                    // when switching between client-side and server-side sorting
                    return 0;
                  })
                  .map((wallet) => {
                    // DEBUG: Log values during render
                    if (process.env.NODE_ENV === 'development' && wallet.address === '4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk') {
                      console.log(`🎨 [Render] jijo_exe: recentPnl30dUsd=${wallet.recentPnl30dUsd}, recentPnl30dPercent=${wallet.recentPnl30dPercent}, formatted=${formatNumber(Math.abs(wallet.recentPnl30dUsd || 0), 2)}, percentFormatted=${formatPercent((wallet.recentPnl30dPercent || 0) / 100)}`);
                    }
                    
                    return (
                    <tr
                      key={wallet.id}
                      onClick={() => {
                        router.push(`/wallet/${wallet.address}`);
                      }}
                      className="border-t border-border hover:bg-muted/50 cursor-pointer"
                    >
                      <td className="px-4 py-3 text-sm">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="underline">
                            {wallet.label || '-'}
                          </span>
                          {wallet.tags && wallet.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {wallet.tags.map((tag: string) => (
                                <span
                                  key={tag}
                                  className="px-2 py-0.5 bg-secondary text-secondary-foreground rounded text-xs"
                                  title={getTagTooltip(tag)}
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-sm">
                          {formatAddress(wallet.address)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-medium">
                        <div className="flex flex-col items-end gap-1">
                          <span>{formatNumber(wallet.score, 1)}</span>
                          {wallet.advancedStats?.scoreBreakdown && (
                            <div className="flex flex-wrap justify-end gap-1 text-[10px] text-muted-foreground">
                              {[
                                { label: 'P', value: wallet.advancedStats.scoreBreakdown.profitabilityScore },
                                { label: 'C', value: wallet.advancedStats.scoreBreakdown.consistencyScore },
                                { label: 'R', value: wallet.advancedStats.scoreBreakdown.riskScore },
                                { label: 'B', value: wallet.advancedStats.scoreBreakdown.behaviourScore },
                              ].map((item) => (
                                <span
                                  key={item.label}
                                  className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-semibold"
                                  title={SCORE_TOOLTIPS[item.label] || ''}
                                >
                                  {item.label}:{Math.round(item.value)}
                                </span>
                              ))}
                              <span
                                className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-semibold"
                                title={SCORE_TOOLTIPS.SF}
                              >
                                SF:{(wallet.advancedStats.scoreBreakdown.sampleFactor || 0).toFixed(2)}
                              </span>
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-sm">
                        {wallet.totalTrades}
                      </td>
                      <td className="px-4 py-3 text-right text-sm">
                        {formatPercent(wallet.winRate)}
                      </td>
                      <td className={`px-4 py-3 text-right text-sm font-medium ${
                        (() => {
                          // Use advancedStats.rolling['30d'] if available (same as detail page), otherwise fallback to recentPnl30dPercent
                          const rolling30d = (wallet.advancedStats as any)?.rolling?.['30d'];
                          const pnlPercent = rolling30d?.realizedRoiPercent ?? wallet.recentPnl30dPercent ?? 0;
                          return pnlPercent >= 0 ? 'text-green-600' : 'text-red-600';
                        })()
                      }`}>
                        {(() => {
                          // Use advancedStats.rolling['30d'] if available (same as detail page), otherwise fallback to recentPnl30dUsd
                          const rolling30d = (wallet.advancedStats as any)?.rolling?.['30d'];
                          const pnlUsd = rolling30d?.realizedPnlUsd ?? wallet.recentPnl30dUsd ?? 0;
                          const pnlPercent = rolling30d?.realizedRoiPercent ?? wallet.recentPnl30dPercent ?? 0;
                          
                          return (
                            <>
                              ${formatNumber(Math.abs(pnlUsd), 2)}{' '}
                              ({(pnlPercent >= 0 ? '+' : '')}{formatPercent(pnlPercent / 100)})
                            </>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-muted-foreground">
                        {formatLastTrade(wallet.lastTradeTimestamp)}
                      </td>
                    </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Pagination */}
        {data && data.total > 0 && (
          <div className="mt-6 flex justify-center items-center space-x-4">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-4 py-2 border border-border rounded-md disabled:opacity-50 hover:bg-muted transition-colors"
            >
              Previous
            </button>
            <span className="text-sm text-muted-foreground">
              Page {page} of {Math.ceil(data.total / data.pageSize)} ({data.total} total)
            </span>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={page >= Math.ceil(data.total / data.pageSize)}
              className="px-4 py-2 border border-border rounded-md disabled:opacity-50 hover:bg-muted transition-colors"
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
