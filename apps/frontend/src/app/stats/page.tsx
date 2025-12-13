'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { fetchStatsOverview, fetchTokenStats } from '@/lib/api';
import { formatNumber, formatPercent, formatHoldTime } from '@/lib/utils';

export default function StatsPage() {
  const [overview, setOverview] = useState<any>(null);
  const [tokenStats, setTokenStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [tokenSortBy, setTokenSortBy] = useState<'tradeCount' | 'totalPnl' | 'winRate' | 'totalVolume'>('tradeCount');
  const [tokenSortOrder, setTokenSortOrder] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    loadStats();
  }, []);

  async function loadStats() {
    setLoading(true);
    try {
      const [overviewData, tokenData] = await Promise.all([
        fetchStatsOverview(),
        fetchTokenStats(),
      ]);
      setOverview(overviewData);
      setTokenStats(tokenData);
    } catch (error) {
      console.error('Error loading stats:', error);
    } finally {
      setLoading(false);
    }
  }

  const sortedTokens = tokenStats?.tokens ? [...tokenStats.tokens].sort((a: any, b: any) => {
    const aValue = a[tokenSortBy] || 0;
    const bValue = b[tokenSortBy] || 0;
    if (tokenSortOrder === 'desc') {
      return bValue - aValue;
    } else {
      return aValue - bValue;
    }
  }) : [];

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-8">
          <div className="text-center">Loading...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <Link 
            href="/" 
            style={{
              color: 'hsl(var(--muted-foreground))',
              fontSize: '.75rem',
              textTransform: 'uppercase',
              letterSpacing: '0.03em',
              padding: '0 0 2rem .5rem'
            }}
            className="inline-block hover:opacity-80"
          >
            ← BACK
          </Link>
          <h1 className="mb-2">Global Statistics</h1>
          <p className="text-muted-foreground">Overview across all tracked wallets</p>
        </div>

        {/* Overview Stats */}
        {overview && (
          <div className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">Overview</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div style={{ border: 'none', background: '#2323234f', backdropFilter: 'blur(20px)' }} className="rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Total Wallets</div>
                <div className="text-2xl font-bold text-white">{overview.totalWallets}</div>
              </div>
              <div style={{ border: 'none', background: '#2323234f', backdropFilter: 'blur(20px)' }} className="rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Total Trades</div>
                <div className="text-2xl font-bold text-white">{formatNumber(overview.totalTrades, 0)}</div>
              </div>
              <div style={{ border: 'none', background: '#2323234f', backdropFilter: 'blur(20px)' }} className="rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Total PnL</div>
                <div className={`text-2xl font-bold ${
                  overview.totalPnl >= 0 ? 'text-green-600' : 'text-red-600'
                }`}>
                  {overview.totalPnl >= 0 ? '+' : ''}
                  ${formatNumber(Math.abs(overview.totalPnl), 2)}
                </div>
              </div>
              <div style={{ border: 'none', background: '#2323234f', backdropFilter: 'blur(20px)' }} className="rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Avg Score</div>
                <div className="text-2xl font-bold text-white">{formatNumber(overview.avgScore, 1)}</div>
              </div>
            </div>
          </div>
        )}

        {/* Average Metrics */}
        {overview && (
          <div className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">Average Metrics</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div style={{ border: 'none', background: '#2323234f', backdropFilter: 'blur(20px)' }} className="rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Avg Win Rate</div>
                <div className="text-2xl font-bold text-white">{formatPercent(overview.avgWinRate || 0)}</div>
              </div>
              <div style={{ border: 'none', background: '#2323234f', backdropFilter: 'blur(20px)' }} className="rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Avg Holding Time</div>
                <div className="text-2xl font-bold text-white">
                  {overview.avgHoldingTime ? formatHoldTime(overview.avgHoldingTime) : '-'}
                </div>
              </div>
              <div style={{ border: 'none', background: '#2323234f', backdropFilter: 'blur(20px)' }} className="rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Avg PnL per Trade</div>
                <div className={`text-2xl font-bold ${
                  (overview.avgPnlPercent || 0) >= 0 ? 'text-green-600' : 'text-red-600'
                }`}>
                  {(overview.avgPnlPercent || 0) >= 0 ? '+' : ''}
                  {formatPercent(overview.avgPnlPercent || 0)}
                </div>
              </div>
              <div style={{ border: 'none', background: '#2323234f', backdropFilter: 'blur(20px)' }} className="rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Avg Risk/Reward</div>
                <div className="text-2xl font-bold text-white">{formatNumber(overview.avgRr || 0, 2)}</div>
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

        {/* Top by Period by Score (points) - NEZÁVISLÉ NA USD */}
        {overview && overview.topPerformers && overview.topPerformers.byPeriodByScore && (
          <div className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">Top Traders by Period (in pts)</h2>
            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            {(['1d', '7d', '14d', '30d'] as const).map((period) => {
              const wallets = overview.topPerformers.byPeriodByScore[period] || [];
              return (
                <div key={period} className="border border-border rounded-lg p-6">
                  <h2 className="text-lg font-semibold mb-4">Score ({period})</h2>
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
                          <div className="text-right font-bold">
                            <span style={{ fontSize: '1.5rem', fontFamily: 'Inter, sans-serif', fontWeight: 'normal' }}>
                              {formatNumber(wallet.score || 0, 1)}
                            </span>
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

        {/* Top by Period PnL (1d, 7d, 14d, 30d) - POUZE USD, BEZ PROCENT */}
        {overview && overview.topPerformers && overview.topPerformers.byPeriod && (
          <div className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">Top Traders by Period (in $)</h2>
            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            {(['1d', '7d', '14d', '30d'] as const).map((period) => {
              const wallets = overview.topPerformers.byPeriod[period] || [];
              return (
                <div key={period} className="border border-border rounded-lg p-6">
                  <h2 className="text-lg font-semibold mb-4">PnL ({period})</h2>
                  <div className="space-y-2">
                    {wallets.length > 0 ? (
                      wallets.map((wallet: any) => {
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
                        const pnlBase = rollingData?.realizedPnl ?? wallet.recentPnl30dBase ?? wallet.recentPnl30dUsd ?? 0; // PnL v SOL
                        const pnlPercent = rollingData?.realizedRoiPercent ?? wallet.recentPnl30dPercent ?? 0;
                        
                        return (
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
                              pnlBase >= 0 ? 'text-green-600' : 'text-red-600'
                            }`}>
                              <span style={{ fontSize: '1.5rem', fontFamily: 'Inter, sans-serif', fontWeight: 'normal' }}>
                                ${formatNumber(Math.abs(pnlBase), 2)}
                              </span>
                            </div>
                          </Link>
                        );
                      })
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

        {/* Bottom Performers - přesunuto naspod stránky */}
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
                          {/* Celkový PnL v USD */}
                          ${formatNumber(wallet.pnlTotalBase || 0, 2)}
                        </div>
                      </Link>
                    ))
                  ) : (
                    <div className="text-sm text-muted-foreground text-center py-4">No data available</div>
                  )}
                </div>
              </div>
              <div className="border border-border rounded-lg p-6">
                <h3 className="text-lg font-semibold mb-4">Lowest Win Rate (30d PnL $)</h3>
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
                          {/* STEJNÁ LOGIKA JAKO NA HOMEPAGE: použij advancedStats.rolling['30d'] pokud je dostupné */}
                          {(() => {
                            const rolling30d = (wallet.advancedStats as any)?.rolling?.['30d'];
                            const pnlBase = rolling30d?.realizedPnl ?? wallet.recentPnl30dBase ?? wallet.recentPnl30dUsd ?? 0; // PnL v USD
                            return `$${formatNumber(pnlBase, 2)}`;
                          })()}
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

        {/* Token Statistics */}
        {tokenStats && tokenStats.tokens && (
          <div className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">Token Statistics</h2>
            
            {/* Sort Controls */}
            <div className="mb-4 flex gap-4 items-center flex-wrap">
              <div className="flex items-center gap-2">
                <label className="text-sm text-muted-foreground">Sort by:</label>
                <select
                  value={tokenSortBy}
                  onChange={(e) => setTokenSortBy(e.target.value as any)}
                  className="px-3 py-2 text-sm border border-border rounded-md bg-background"
                >
                  <option value="tradeCount">Trade Count</option>
                  <option value="totalPnl">Total PnL</option>
                  <option value="winRate">Win Rate</option>
                  <option value="totalVolume">Total Volume</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-sm text-muted-foreground">Order:</label>
                <select
                  value={tokenSortOrder}
                  onChange={(e) => setTokenSortOrder(e.target.value as any)}
                  className="px-3 py-2 text-sm border border-border rounded-md bg-background"
                >
                  <option value="desc">Descending</option>
                  <option value="asc">Ascending</option>
                </select>
              </div>
            </div>

            {/* Token Stats Summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <div className="border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Total Tokens</div>
                <div className="text-2xl font-bold">{tokenStats.tokens.length}</div>
              </div>
              <div className="border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Total Volume</div>
                <div className="text-2xl font-bold">
                  ${formatNumber(tokenStats.tokens.reduce((sum: number, t: any) => sum + (t.totalVolume || 0), 0), 0)}
                </div>
              </div>
              <div className="border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Total PnL</div>
                <div className={`text-2xl font-bold ${
                  tokenStats.tokens.reduce((sum: number, t: any) => sum + (t.totalPnl || 0), 0) >= 0 
                    ? 'text-green-600' 
                    : 'text-red-600'
                }`}>
                  {tokenStats.tokens.reduce((sum: number, t: any) => sum + (t.totalPnl || 0), 0) >= 0 ? '+' : ''}
                  ${formatNumber(Math.abs(tokenStats.tokens.reduce((sum: number, t: any) => sum + (t.totalPnl || 0), 0)), 0)}
                </div>
              </div>
              <div className="border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground mb-1">Avg Win Rate</div>
                <div className="text-2xl font-bold">
                  {formatPercent(
                    tokenStats.tokens
                      .filter((t: any) => t.closedPositions > 0)
                      .reduce((sum: number, t: any) => sum + (t.winRate || 0), 0) /
                    tokenStats.tokens.filter((t: any) => t.closedPositions > 0).length || 0
                  )}
                </div>
              </div>
            </div>

            {/* Top Tokens Table */}
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-muted/30">
                    <tr>
                      <th className="px-4 py-3 text-left text-sm font-medium">TOKEN</th>
                      <th className="px-4 py-3 text-right text-sm font-medium">TRADES</th>
                      <th className="px-4 py-3 text-right text-sm font-medium">WALLETS</th>
                      <th className="px-4 py-3 text-right text-sm font-medium">CLOSED POS</th>
                      <th className="px-4 py-3 text-right text-sm font-medium">WIN RATE</th>
                      <th className="px-4 py-3 text-right text-sm font-medium">TOTAL PnL</th>
                      <th className="px-4 py-3 text-right text-sm font-medium">AVG PnL</th>
                      <th className="px-4 py-3 text-right text-sm font-medium">VOLUME</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedTokens.slice(0, 50).map((token: any) => (
                      <tr key={token.tokenId} className="border-t border-border hover:bg-muted/50">
                        <td className="px-4 py-3 text-sm">
                          {token.token?.mintAddress ? (
                            <a
                              href={`https://birdeye.so/solana/token/${token.token.mintAddress}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-white hover:opacity-80 hover:underline"
                            >
                              {token.token.symbol 
                                ? `$${token.token.symbol}` 
                                : token.token.name 
                                ? token.token.name 
                                : `${token.token.mintAddress?.slice(0, 8)}...${token.token.mintAddress?.slice(-8)}`}
                            </a>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-mono">
                          {token.tradeCount}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-mono">
                          {token.uniqueWallets}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-mono">
                          {token.closedPositions || 0}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-mono">
                          {token.closedPositions > 0 ? formatPercent(token.winRate / 100) : '-'}
                        </td>
                        <td className={`px-4 py-3 text-right text-sm font-mono ${
                          (token.totalPnl || 0) >= 0 ? 'text-green-400' : 'text-red-400'
                        }`}>
                          {(token.totalPnl || 0) !== 0 ? (
                            <>
                              {(token.totalPnl || 0) >= 0 ? '+' : ''}
                              ${formatNumber(Math.abs(token.totalPnl || 0), 2)}
                            </>
                          ) : '-'}
                        </td>
                        <td className={`px-4 py-3 text-right text-sm font-mono ${
                          (token.avgPnl || 0) >= 0 ? 'text-green-400' : 'text-red-400'
                        }`}>
                          {token.closedPositions > 0 ? (
                            <>
                              {(token.avgPnl || 0) >= 0 ? '+' : ''}
                              ${formatNumber(Math.abs(token.avgPnl || 0), 2)}
                            </>
                          ) : '-'}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-mono">
                          ${formatNumber(token.totalVolume || 0, 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

