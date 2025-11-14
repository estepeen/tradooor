'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { fetchSmartWallet, fetchTrades } from '@/lib/api';
import { formatAddress, formatPercent, formatNumber, formatDate, copyToClipboard } from '@/lib/utils';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import type { SmartWallet, Trade } from '@solbot/shared';

export default function WalletDetailPage() {
  const params = useParams();
  const walletId = params.id as string;
  
  const [wallet, setWallet] = useState<any>(null);
  const [trades, setTrades] = useState<{ trades: Trade[]; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [tokenFilter, setTokenFilter] = useState<string>('');
  const [timeframeFilter, setTimeframeFilter] = useState<string>('all');
  const [copiedAddress, setCopiedAddress] = useState(false);

  useEffect(() => {
    if (walletId) {
      loadData();
    }
  }, [walletId, tokenFilter, timeframeFilter]);

  async function loadData() {
    setLoading(true);
    try {
      // Calculate date range for timeframe filter
      let fromDate: string | undefined;
      const now = new Date();
      switch (timeframeFilter) {
        case '24h':
          fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
          break;
        case '7d':
          fromDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
          break;
        case '30d':
          fromDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
          break;
        default:
          fromDate = undefined;
      }

      // Get unique tokens for filter
      const [walletData, tradesData] = await Promise.all([
        fetchSmartWallet(walletId),
        fetchTrades(walletId, { 
          page: 1, 
          pageSize: 100,
          tokenId: tokenFilter || undefined,
          fromDate,
        }),
      ]);
      setWallet(walletData);
      setTrades(tradesData);
    } catch (error) {
      console.error('Error loading wallet data:', error);
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

  if (!wallet) {
    return (
      <div className="min-h-screen bg-background p-8">
        <div className="container mx-auto">
          <div className="text-center">Wallet not found</div>
        </div>
      </div>
    );
  }

  // Prepare chart data
  const scoreChartData = wallet.metricsHistory?.map((m: any) => ({
    date: new Date(m.timestamp).toLocaleDateString(),
    score: m.score,
  })) || [];

  const pnlChartData = wallet.metricsHistory?.map((m: any) => ({
    date: new Date(m.timestamp).toLocaleDateString(),
    pnl: m.recentPnl30dPercent,
  })) || [];

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="container mx-auto">
        <Link href="/wallets" className="text-primary hover:underline mb-4 inline-block">
          ← Back to Wallets
        </Link>

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">
            {wallet.label || formatAddress(wallet.address)}
          </h1>
          <div className="flex items-center gap-2 mb-4">
            <p className="font-mono text-sm text-muted-foreground">
              {wallet.address}
            </p>
            <button
              onClick={async () => {
                const success = await copyToClipboard(wallet.address);
                if (success) {
                  setCopiedAddress(true);
                  setTimeout(() => setCopiedAddress(false), 2000);
                }
              }}
              className="text-muted-foreground hover:text-foreground text-sm"
              title="Copy address"
            >
              {copiedAddress ? '✓ Copied!' : '📋 Copy'}
            </button>
          </div>
          {wallet.tags && wallet.tags.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {wallet.tags.map((tag: string) => (
                <span
                  key={tag}
                  className="px-2 py-1 bg-secondary text-secondary-foreground rounded text-xs"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div className="border border-border rounded-lg p-4">
            <div className="text-sm text-muted-foreground mb-1">Score</div>
            <div className="text-2xl font-bold">{formatNumber(wallet.score, 1)}</div>
          </div>
          <div className="border border-border rounded-lg p-4">
            <div className="text-sm text-muted-foreground mb-1">Total Trades</div>
            <div className="text-2xl font-bold">{wallet.totalTrades}</div>
          </div>
          <div className="border border-border rounded-lg p-4">
            <div className="text-sm text-muted-foreground mb-1">Win Rate</div>
            <div className="text-2xl font-bold">{formatPercent(wallet.winRate)}</div>
          </div>
          <div className="border border-border rounded-lg p-4">
            <div className="text-sm text-muted-foreground mb-1">Recent PnL (30d)</div>
            <div className={`text-2xl font-bold ${
              wallet.recentPnl30dPercent >= 0 ? 'text-green-600' : 'text-red-600'
            }`}>
              {wallet.recentPnl30dPercent >= 0 ? '+' : ''}
              {formatPercent(wallet.recentPnl30dPercent / 100)}
            </div>
          </div>
        </div>

        {/* Advanced Stats */}
        {wallet.advancedStats && (
          <div className="border border-border rounded-lg p-6 mb-8">
            <h2 className="text-lg font-semibold mb-4">Advanced Statistics</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <div className="text-sm text-muted-foreground mb-1">Profit Factor</div>
                <div className="text-xl font-bold">
                  {wallet.advancedStats.profitFactor === Infinity 
                    ? '∞' 
                    : formatNumber(wallet.advancedStats.profitFactor, 2)}
                </div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Max Win Streak</div>
                <div className="text-xl font-bold">{wallet.advancedStats.maxWinStreak}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Max Loss Streak</div>
                <div className="text-xl font-bold">{wallet.advancedStats.maxLossStreak}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Avg Win</div>
                <div className="text-xl font-bold text-green-600">
                  +{formatPercent(wallet.advancedStats.avgWin / 100)}
                </div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Avg Loss</div>
                <div className="text-xl font-bold text-red-600">
                  {formatPercent(wallet.advancedStats.avgLoss / 100)}
                </div>
              </div>
              {wallet.advancedStats.bestTrade && (
                <div>
                  <div className="text-sm text-muted-foreground mb-1">Best Trade</div>
                  <div className="text-xl font-bold text-green-600">
                    +{formatPercent(wallet.advancedStats.bestTrade.pnlPercent / 100)}
                  </div>
                </div>
              )}
              {wallet.advancedStats.worstTrade && (
                <div>
                  <div className="text-sm text-muted-foreground mb-1">Worst Trade</div>
                  <div className="text-xl font-bold text-red-600">
                    {formatPercent(wallet.advancedStats.worstTrade.pnlPercent / 100)}
                  </div>
                </div>
              )}
            </div>

            {/* Token Stats */}
            {wallet.advancedStats.tokenStats && wallet.advancedStats.tokenStats.length > 0 && (
              <div className="mt-6">
                <h3 className="text-md font-semibold mb-3">Top Tokens</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-2">Token</th>
                        <th className="text-right py-2">Trades</th>
                        <th className="text-right py-2">Win Rate</th>
                        <th className="text-right py-2">Total PnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {wallet.advancedStats.tokenStats.slice(0, 10).map((stat: any) => (
                        <tr key={stat.tokenId} className="border-b border-border">
                          <td className="py-2">{stat.tokenId.slice(0, 8)}...</td>
                          <td className="text-right py-2">{stat.count}</td>
                          <td className="text-right py-2">{formatPercent(stat.winRate)}</td>
                          <td className={`text-right py-2 ${
                            stat.totalPnl >= 0 ? 'text-green-600' : 'text-red-600'
                          }`}>
                            {stat.totalPnl >= 0 ? '+' : ''}
                            {formatNumber(stat.totalPnl, 2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* DEX Stats */}
            {wallet.advancedStats.dexStats && wallet.advancedStats.dexStats.length > 0 && (
              <div className="mt-6">
                <h3 className="text-md font-semibold mb-3">DEX Usage</h3>
                <div className="flex flex-wrap gap-4">
                  {wallet.advancedStats.dexStats.map((stat: any) => (
                    <div key={stat.dex} className="border border-border rounded p-3">
                      <div className="text-sm text-muted-foreground">{stat.dex}</div>
                      <div className="text-lg font-bold">{stat.count} trades</div>
                      <div className={`text-sm ${
                        stat.totalPnl >= 0 ? 'text-green-600' : 'text-red-600'
                      }`}>
                        {stat.totalPnl >= 0 ? '+' : ''}
                        {formatNumber(stat.totalPnl, 2)} PnL
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Charts */}
        <div className="grid md:grid-cols-2 gap-6 mb-8">
          <div className="border border-border rounded-lg p-6">
            <h2 className="text-lg font-semibold mb-4">Score Over Time</h2>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={scoreChartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="score" stroke="#8884d8" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="border border-border rounded-lg p-6">
            <h2 className="text-lg font-semibold mb-4">Recent PnL (30d) Over Time</h2>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={pnlChartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="pnl"
                  stroke="#82ca9d"
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Recent Trades */}
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="p-4 border-b border-border">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold">Recent Trades</h2>
            </div>
            
            {/* Filters */}
            <div className="flex gap-4 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <input
                  type="text"
                  placeholder="Filter by token..."
                  value={tokenFilter}
                  onChange={(e) => setTokenFilter(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background"
                />
              </div>
              <select
                value={timeframeFilter}
                onChange={(e) => setTimeframeFilter(e.target.value)}
                className="px-3 py-2 text-sm border border-border rounded-md bg-background"
              >
                <option value="all">All time</option>
                <option value="24h">Last 24 hours</option>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
              </select>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium">Timestamp</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Token</th>
                  <th className="px-4 py-3 text-center text-sm font-medium">Side</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">Amount</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">Price</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">PnL</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">DEX</th>
                </tr>
              </thead>
              <tbody>
                {trades?.trades.map((trade) => (
                  <tr key={trade.id} className="border-t border-border">
                    <td className="px-4 py-3 text-sm">
                      {formatDate(trade.timestamp)}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {trade.token?.symbol || formatAddress(trade.token?.mintAddress || '')}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`px-2 py-1 rounded text-xs ${
                        trade.side === 'buy'
                          ? 'bg-green-100 text-green-800'
                          : 'bg-red-100 text-red-800'
                      }`}>
                        {trade.side.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-mono">
                      {formatNumber(Number(trade.amountToken), 4)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-mono">
                      {formatNumber(Number(trade.priceBasePerToken), 6)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm">
                      {/* TODO: Calculate PnL per trade when position is closed */}
                      <span className="text-muted-foreground text-xs">-</span>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {trade.dex}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(!trades || trades.trades.length === 0) && (
            <div className="text-center py-12 text-muted-foreground">
              No trades found
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

