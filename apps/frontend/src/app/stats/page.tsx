'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { fetchStatsOverview } from '@/lib/api';
import { formatNumber, formatPercent, formatHoldTime } from '@/lib/utils';

export default function StatsPage() {
  const [overview, setOverview] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
  }, []);

  async function loadStats() {
    setLoading(true);
    try {
      const overviewData = await fetchStatsOverview();
      setOverview(overviewData);
    } catch (error) {
      console.error('Error loading stats:', error);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background p-8">
        <div className="container mx-auto">
          <div className="text-center">Loading...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="container mx-auto">
        <div className="mb-8">
          <Link href="/wallets" className="text-primary hover:underline mb-4 inline-block">
            Back to Wallets
          </Link>
          <h1 className="mb-2">Global Statistics</h1>
          <p className="text-muted-foreground">Overview across all tracked wallets</p>
        </div>

        {/* Overview Stats */}
        {overview && (
          <div className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">Overview</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Total Wallets</div>
                <div className="text-2xl font-bold">{overview.totalWallets}</div>
              </div>
              <div className="border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Total Trades</div>
                <div className="text-2xl font-bold">{overview.totalTrades}</div>
              </div>
              <div className="border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Total PnL</div>
                <div className={`text-2xl font-bold ${
                  overview.totalPnl >= 0 ? 'text-green-600' : 'text-red-600'
                }`}>
                  {overview.totalPnl >= 0 ? '+' : ''}
                  {formatNumber(overview.totalPnl, 2)}
                </div>
              </div>
              <div className="border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Avg Score</div>
                <div className="text-2xl font-bold">{formatNumber(overview.avgScore, 1)}</div>
              </div>
            </div>
          </div>
        )}

        {/* Average Metrics */}
        {overview && (
          <div className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">Average Metrics</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Avg Win Rate</div>
                <div className="text-2xl font-bold">{formatPercent(overview.avgWinRate || 0)}</div>
              </div>
              <div className="border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Avg Holding Time</div>
                <div className="text-2xl font-bold">
                  {overview.avgHoldingTime ? formatHoldTime(overview.avgHoldingTime) : '-'}
                </div>
              </div>
              <div className="border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Avg PnL per Trade</div>
                <div className={`text-2xl font-bold ${
                  (overview.avgPnlPercent || 0) >= 0 ? 'text-green-600' : 'text-red-600'
                }`}>
                  {(overview.avgPnlPercent || 0) >= 0 ? '+' : ''}
                  {formatPercent(overview.avgPnlPercent || 0)}
                </div>
              </div>
              <div className="border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Avg Risk/Reward</div>
                <div className="text-2xl font-bold">{formatNumber(overview.avgRr || 0, 2)}</div>
              </div>
            </div>
          </div>
        )}

        {/* Activity Stats */}
        {overview && (
          <div className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">Activity</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Active Wallets (7d)</div>
                <div className="text-2xl font-bold">{overview.activeWallets7d || 0}</div>
              </div>
              <div className="border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Active Wallets (30d)</div>
                <div className="text-2xl font-bold">{overview.activeWallets30d || 0}</div>
              </div>
              <div className="border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Trades (1d)</div>
                <div className="text-2xl font-bold">{overview.trades1d || 0}</div>
              </div>
              <div className="border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Avg Trades/Wallet</div>
                <div className="text-2xl font-bold">{formatNumber(overview.avgTradesPerWallet || 0, 1)}</div>
              </div>
            </div>
          </div>
        )}

        {/* Performance Distribution */}
        {overview && (
          <div className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">Performance Distribution</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
              <div className="border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Profitable Wallets</div>
                <div className="text-2xl font-bold text-green-600">{overview.profitableWallets || 0}</div>
              </div>
              <div className="border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Losing Wallets</div>
                <div className="text-2xl font-bold text-red-600">{overview.losingWallets || 0}</div>
              </div>
              <div className="border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Break Even</div>
                <div className="text-2xl font-bold">
                  {(overview.totalWallets || 0) - (overview.profitableWallets || 0) - (overview.losingWallets || 0)}
                </div>
              </div>
            </div>
            {overview.scoreDistribution && (
              <div className="grid grid-cols-3 gap-4">
                <div className="border border-border rounded-lg p-4">
                  <div className="text-sm text-muted-foreground mb-1">High Score (≥70)</div>
                  <div className="text-2xl font-bold text-green-600">{overview.scoreDistribution.high || 0}</div>
                </div>
                <div className="border border-border rounded-lg p-4">
                  <div className="text-sm text-muted-foreground mb-1">Medium Score (50-69)</div>
                  <div className="text-2xl font-bold text-yellow-600">{overview.scoreDistribution.medium || 0}</div>
                </div>
                <div className="border border-border rounded-lg p-4">
                  <div className="text-sm text-muted-foreground mb-1">Low Score (&lt;50)</div>
                  <div className="text-2xl font-bold text-red-600">{overview.scoreDistribution.low || 0}</div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Volume Stats */}
        {overview && (
          <div className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">Volume (30d)</h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Total Volume</div>
                <div className="text-2xl font-bold">${formatNumber(overview.totalVolume30d || 0, 0)}</div>
              </div>
              <div className="border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Avg Volume/Wallet</div>
                <div className="text-2xl font-bold">${formatNumber(overview.avgVolumePerWallet || 0, 0)}</div>
              </div>
            </div>
          </div>
        )}

        {/* Top Performers */}
        {overview && overview.topPerformers && (
          <div className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">Top Performers</h2>
            <div className="grid md:grid-cols-3 gap-6">
              <div className="border border-border rounded-lg p-6">
                <h2 className="text-lg font-semibold mb-4">Top by Score</h2>
                <div className="space-y-2">
                  {overview.topPerformers.byScore.map((wallet: any, idx: number) => (
                    <Link
                      key={wallet.id}
                      href={`/wallet/${wallet.address}`}
                      className="flex justify-between items-center p-2 hover:bg-muted rounded"
                    >
                      <div>
                        <div className="font-medium">{wallet.label || wallet.address.slice(0, 8)}</div>
                        <div className="text-sm text-muted-foreground">{wallet.totalTrades} trades</div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold">{formatNumber(wallet.score, 1)}</div>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>

              <div className="border border-border rounded-lg p-6">
                <h2 className="text-lg font-semibold mb-4">Top by Total PnL</h2>
                <div className="space-y-2">
                  {overview.topPerformers.byPnl.map((wallet: any, idx: number) => (
                    <Link
                      key={wallet.id}
                      href={`/wallet/${wallet.address}`}
                      className="flex justify-between items-center p-2 hover:bg-muted rounded"
                    >
                      <div>
                        <div className="font-medium">{wallet.label || wallet.address.slice(0, 8)}</div>
                        <div className="text-sm text-muted-foreground">{wallet.totalTrades} trades</div>
                      </div>
                      <div className={`text-right font-bold ${
                        wallet.pnlTotalBase >= 0 ? 'text-green-600' : 'text-red-600'
                      }`}>
                        {wallet.pnlTotalBase >= 0 ? '+' : ''}
                        {formatNumber(wallet.pnlTotalBase, 2)}
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Bottom Performers */}
        {overview && overview.bottomPerformers && (
          <div className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">Bottom Performers</h2>
            <div className="grid md:grid-cols-2 gap-6">
              <div className="border border-border rounded-lg p-6">
                <h3 className="text-lg font-semibold mb-4">Worst PnL</h3>
                <div className="space-y-2">
                  {overview.bottomPerformers.byPnl && overview.bottomPerformers.byPnl.length > 0 ? (
                    overview.bottomPerformers.byPnl.map((wallet: any) => (
                      <Link
                        key={wallet.id}
                        href={`/wallet/${wallet.address}`}
                        className="flex justify-between items-center p-2 hover:bg-muted rounded"
                      >
                        <div>
                          <div className="font-medium">{wallet.label || wallet.address.slice(0, 8)}</div>
                          <div className="text-sm text-muted-foreground">{wallet.totalTrades} trades</div>
                        </div>
                        <div className="text-right font-bold text-red-600">
                          {formatNumber(wallet.pnlTotalBase || 0, 2)}
                        </div>
                      </Link>
                    ))
                  ) : (
                    <div className="text-sm text-muted-foreground text-center py-4">No data available</div>
                  )}
                </div>
              </div>
              <div className="border border-border rounded-lg p-6">
                <h3 className="text-lg font-semibold mb-4">Lowest Win Rate</h3>
                <div className="space-y-2">
                  {overview.bottomPerformers.byWinRate && overview.bottomPerformers.byWinRate.length > 0 ? (
                    overview.bottomPerformers.byWinRate.map((wallet: any) => (
                      <Link
                        key={wallet.id}
                        href={`/wallet/${wallet.address}`}
                        className="flex justify-between items-center p-2 hover:bg-muted rounded"
                      >
                        <div>
                          <div className="font-medium">{wallet.label || wallet.address.slice(0, 8)}</div>
                          <div className="text-sm text-muted-foreground">{wallet.totalTrades} trades</div>
                        </div>
                        <div className="text-right font-bold text-red-600">
                          {formatPercent(wallet.winRate || 0)}
                        </div>
                      </Link>
                    ))
                  ) : (
                    <div className="text-sm text-muted-foreground text-center py-4">No data available</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Top by Period PnL (1d, 7d, 14d, 30d) */}
        {overview && overview.topPerformers && overview.topPerformers.byPeriod && (
          <div className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">Top Traders by Period</h2>
            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            {(['1d', '7d', '14d', '30d'] as const).map((period) => {
              const wallets = overview.topPerformers.byPeriod[period] || [];
              return (
                <div key={period} className="border border-border rounded-lg p-6">
                  <h2 className="text-lg font-semibold mb-4">PnL ({period})</h2>
                  <div className="space-y-2">
                    {wallets.length > 0 ? (
                      wallets.map((wallet: any) => (
                        <Link
                          key={wallet.id}
                          href={`/wallet/${wallet.address}`}
                          className="flex justify-between items-center p-2 hover:bg-muted rounded"
                        >
                          <div>
                            <div className="font-medium">{wallet.label || wallet.address.slice(0, 8)}</div>
                            <div className="text-sm text-muted-foreground">{wallet.totalTrades} trades</div>
                          </div>
                          <div className={`text-right font-bold ${
                            (() => {
                              // STEJNÁ LOGIKA JAKO NA HOMEPAGE: použij advancedStats.rolling pokud je dostupné
                              const rolling = (wallet.advancedStats as any)?.rolling;
                              let rollingKey: string;
                              if (period === '1d') {
                                rollingKey = '7d'; // Pro 1d použij 7d jako fallback (stejně jako homepage)
                              } else if (period === '14d') {
                                rollingKey = '30d'; // Pro 14d použij 30d jako aproximaci
                              } else {
                                rollingKey = period; // Pro 7d a 30d použij přímo
                              }
                              const rollingData = rolling?.[rollingKey];
                              const pnlPercent = rollingData?.realizedRoiPercent ?? wallet.recentPnl30dPercent ?? 0;
                              return pnlPercent >= 0 ? 'text-green-600' : 'text-red-600';
                            })()
                          }`}>
                            {(() => {
                              // STEJNÁ LOGIKA JAKO NA HOMEPAGE: použij advancedStats.rolling pokud je dostupné
                              const rolling = (wallet.advancedStats as any)?.rolling;
                              let rollingKey: string;
                              if (period === '1d') {
                                rollingKey = '7d'; // Pro 1d použij 7d jako fallback (stejně jako homepage)
                              } else if (period === '14d') {
                                rollingKey = '30d'; // Pro 14d použij 30d jako aproximaci
                              } else {
                                rollingKey = period; // Pro 7d a 30d použij přímo
                              }
                              const rollingData = rolling?.[rollingKey];
                              const pnlUsd = rollingData?.realizedPnlUsd ?? wallet.recentPnl30dUsd ?? 0;
                              const pnlPercent = rollingData?.realizedRoiPercent ?? wallet.recentPnl30dPercent ?? 0;
                              
                              if (pnlUsd !== undefined && pnlUsd !== null && pnlUsd !== 0) {
                                return (
                                  <>
                                    <span style={{ fontSize: '1.5rem', fontFamily: 'Inter, sans-serif', fontWeight: 'normal' }}>
                                      ${formatNumber(Math.abs(pnlUsd), 2)}
                                    </span>
                                    {' '}
                                    <span style={{ fontSize: '0.875rem', fontFamily: 'Inter, sans-serif', fontWeight: 'normal' }}>
                                      ({pnlPercent >= 0 ? '+' : ''}{formatPercent(pnlPercent / 100)})
                                    </span>
                                  </>
                                );
                              } else {
                                return `${pnlPercent >= 0 ? '+' : ''}${formatPercent(pnlPercent / 100)}`;
                              }
                            })()}
                          </div>
                        </Link>
                      ))
                    ) : (
                      <div className="text-sm text-muted-foreground text-center py-4">No data available</div>
                    )}
                  </div>
                </div>
              );
            })}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

