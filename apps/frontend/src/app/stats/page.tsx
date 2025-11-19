'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { fetchStatsOverview, fetchTokenStats, fetchDexStats } from '@/lib/api';
import { formatNumber, formatPercent } from '@/lib/utils';

export default function StatsPage() {
  const [overview, setOverview] = useState<any>(null);
  const [tokenStats, setTokenStats] = useState<any>(null);
  const [dexStats, setDexStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
  }, []);

  async function loadStats() {
    setLoading(true);
    try {
      const [overviewData, tokenData, dexData] = await Promise.all([
        fetchStatsOverview(),
        fetchTokenStats(),
        fetchDexStats(),
      ]);
      setOverview(overviewData);
      setTokenStats(tokenData);
      setDexStats(dexData);
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
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
        )}

        {/* Top Performers */}
        {overview && overview.topPerformers && (
          <div className="grid md:grid-cols-3 gap-6 mb-8">
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

            <div className="border border-border rounded-lg p-6">
              <h2 className="text-lg font-semibold mb-4">Top by Recent PnL (30d)</h2>
              <div className="space-y-2">
                {overview.topPerformers.byRecentPnl.map((wallet: any, idx: number) => (
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
                      wallet.recentPnl30dPercent >= 0 ? 'text-green-600' : 'text-red-600'
                    }`}>
                      {wallet.recentPnl30dUsd !== undefined && wallet.recentPnl30dUsd !== null
                        ? (
                          <>
                            <span style={{ fontSize: '1.5rem', fontFamily: 'Inter, sans-serif', fontWeight: 'normal' }}>
                              ${formatNumber(Math.abs(wallet.recentPnl30dUsd), 2)}
                            </span>
                            {' '}
                            <span style={{ fontSize: '0.875rem', fontFamily: 'Inter, sans-serif', fontWeight: 'normal' }}>
                              ({wallet.recentPnl30dPercent >= 0 ? '+' : ''}{formatPercent(wallet.recentPnl30dPercent / 100)})
                            </span>
                          </>
                        )
                        : `${wallet.recentPnl30dPercent >= 0 ? '+' : ''}${formatPercent(wallet.recentPnl30dPercent / 100)}`
                      }
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Token Stats */}
        {tokenStats && tokenStats.tokens && tokenStats.tokens.length > 0 && (
          <div className="border border-border rounded-lg p-6 mb-8">
            <h2 className="text-lg font-semibold mb-4">Most Traded Tokens</h2>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-muted">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium">Token</th>
                    <th className="px-4 py-3 text-right text-sm font-medium">Trades</th>
                    <th className="px-4 py-3 text-right text-sm font-medium">Unique Wallets</th>
                    <th className="px-4 py-3 text-right text-sm font-medium">Buys</th>
                    <th className="px-4 py-3 text-right text-sm font-medium">Sells</th>
                  </tr>
                </thead>
                <tbody>
                  {tokenStats.tokens.slice(0, 20).map((token: any) => (
                    <tr key={token.tokenId} className="border-t border-border">
                      <td className="px-4 py-3 text-sm">
                        {token.token?.symbol || token.token?.mintAddress?.slice(0, 8) || token.tokenId.slice(0, 8)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm">{token.tradeCount}</td>
                      <td className="px-4 py-3 text-right text-sm">{token.uniqueWallets}</td>
                      <td className="px-4 py-3 text-right text-sm">{token.buyCount}</td>
                      <td className="px-4 py-3 text-right text-sm">{token.sellCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* DEX Stats */}
        {dexStats && dexStats.dexes && dexStats.dexes.length > 0 && (
          <div className="border border-border rounded-lg p-6">
            <h2 className="text-lg font-semibold mb-4">DEX Usage</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {dexStats.dexes.map((dex: any) => (
                <div key={dex.dex} className="border border-border rounded p-4">
                  <div className="text-sm text-muted-foreground mb-1">{dex.dex}</div>
                  <div className="text-2xl font-bold">{dex.tradeCount}</div>
                  <div className="text-xs text-muted-foreground">trades</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

