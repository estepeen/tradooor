'use client';

import { useEffect, useState } from 'react';
import { fetchPaperTradingPortfolio, fetchPaperTrades, fetchPaperPortfolioHistory } from '@/lib/api';
import { formatNumber, formatPercent, formatDate } from '@/lib/utils';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

export default function PaperTradingPage() {
  const [portfolio, setPortfolio] = useState<any>(null);
  const [trades, setTrades] = useState<any[]>([]);
  const [portfolioHistory, setPortfolioHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'trades' | 'history'>('overview');

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    try {
      const [portfolioData, tradesData, historyData] = await Promise.all([
        fetchPaperTradingPortfolio(),
        fetchPaperTrades({ limit: 100 }),
        fetchPaperPortfolioHistory(100),
      ]);
      setPortfolio(portfolioData);
      setTrades(tradesData.trades || []);
      setPortfolioHistory(historyData.snapshots || []);
    } catch (error) {
      console.error('Error loading paper trading data:', error);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="text-center">Loading...</div>
      </div>
    );
  }

  const openTrades = trades.filter(t => t.status === 'open');
  const closedTrades = trades.filter(t => t.status === 'closed');

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-4xl font-bold mb-8">Paper Trading</h1>

      {/* Tabs */}
      <div className="flex gap-4 mb-6 border-b border-border">
        <button
          onClick={() => setActiveTab('overview')}
          className={`pb-2 px-4 ${activeTab === 'overview' ? 'border-b-2 border-primary' : ''}`}
        >
          Overview
        </button>
        <button
          onClick={() => setActiveTab('trades')}
          className={`pb-2 px-4 ${activeTab === 'trades' ? 'border-b-2 border-primary' : ''}`}
        >
          Trades ({trades.length})
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={`pb-2 px-4 ${activeTab === 'history' ? 'border-b-2 border-primary' : ''}`}
        >
          Portfolio History
        </button>
      </div>

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Portfolio Stats */}
          {portfolio && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-muted/30 rounded-lg p-4">
                <div className="text-sm text-muted-foreground">Total Value</div>
                <div className="text-2xl font-bold">${formatNumber(portfolio.totalValueUsd, 2)}</div>
              </div>
              <div className="bg-muted/30 rounded-lg p-4">
                <div className="text-sm text-muted-foreground">Total Cost</div>
                <div className="text-2xl font-bold">${formatNumber(portfolio.totalCostUsd, 2)}</div>
              </div>
              <div className={`bg-muted/30 rounded-lg p-4 ${portfolio.totalPnlUsd >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                <div className="text-sm text-muted-foreground">Total PnL</div>
                <div className="text-2xl font-bold">
                  ${formatNumber(Math.abs(portfolio.totalPnlUsd), 2)} ({portfolio.totalPnlPercent >= 0 ? '+' : ''}{formatPercent(portfolio.totalPnlPercent / 100)})
                </div>
              </div>
              <div className="bg-muted/30 rounded-lg p-4">
                <div className="text-sm text-muted-foreground">Win Rate</div>
                <div className="text-2xl font-bold">
                  {portfolio.winRate ? formatPercent(portfolio.winRate) : 'N/A'}
                </div>
              </div>
            </div>
          )}

          {/* Positions Summary */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-muted/30 rounded-lg p-4">
              <div className="text-sm text-muted-foreground">Open Positions</div>
              <div className="text-2xl font-bold">{portfolio?.openPositions || 0}</div>
            </div>
            <div className="bg-muted/30 rounded-lg p-4">
              <div className="text-sm text-muted-foreground">Closed Positions</div>
              <div className="text-2xl font-bold">{portfolio?.closedPositions || 0}</div>
            </div>
            <div className="bg-muted/30 rounded-lg p-4">
              <div className="text-sm text-muted-foreground">Total Trades</div>
              <div className="text-2xl font-bold">{portfolio?.totalTrades || 0}</div>
            </div>
          </div>

          {/* Portfolio History Chart */}
          {portfolioHistory.length > 0 && (
            <div className="bg-muted/30 rounded-lg p-4">
              <h2 className="text-xl font-semibold mb-4">Portfolio Value Over Time</h2>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={portfolioHistory.map(s => ({
                  timestamp: new Date(s.timestamp).toLocaleDateString(),
                  value: Number(s.totalValueUsd),
                  pnl: Number(s.totalPnlUsd),
                }))}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="timestamp" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="value" stroke="#8884d8" name="Portfolio Value (USD)" />
                  <Line type="monotone" dataKey="pnl" stroke="#82ca9d" name="Total PnL (USD)" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {/* Trades Tab */}
      {activeTab === 'trades' && (
        <div className="space-y-4">
          <div className="flex gap-4 mb-4">
            <button
              onClick={() => setActiveTab('trades')}
              className="px-4 py-2 bg-primary text-primary-foreground rounded"
            >
              All ({trades.length})
            </button>
            <button
              onClick={() => setActiveTab('trades')}
              className="px-4 py-2 bg-muted rounded"
            >
              Open ({openTrades.length})
            </button>
            <button
              onClick={() => setActiveTab('trades')}
              className="px-4 py-2 bg-muted rounded"
            >
              Closed ({closedTrades.length})
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/30">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium">Date</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Wallet</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Token</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">Side</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">Amount</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">Price</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">Status</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">PnL</th>
                </tr>
              </thead>
              <tbody>
                {trades.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-6 text-center text-muted-foreground">
                      No paper trades yet
                    </td>
                  </tr>
                ) : (
                  trades.map((trade) => (
                    <tr key={trade.id} className="border-t border-border hover:bg-muted/50">
                      <td className="px-4 py-3 text-sm">
                        {formatDate(new Date(trade.timestamp))}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {trade.wallet?.label || trade.wallet?.address?.substring(0, 8) || '-'}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {trade.token?.symbol ? `$${trade.token.symbol}` : trade.token?.name || '-'}
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-mono">
                        {trade.side.toUpperCase()}
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-mono">
                        {formatNumber(trade.amountToken, 6)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-mono">
                        ${formatNumber(trade.priceBasePerToken, 6)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm">
                        <span className={`px-2 py-1 rounded text-xs ${
                          trade.status === 'open' ? 'bg-green-500/20 text-green-400' :
                          trade.status === 'closed' ? 'bg-gray-500/20 text-gray-400' :
                          'bg-red-500/20 text-red-400'
                        }`}>
                          {trade.status.toUpperCase()}
                        </span>
                      </td>
                      <td className={`px-4 py-3 text-right text-sm font-mono ${
                        trade.realizedPnl && trade.realizedPnl >= 0 ? 'text-green-400' : 'text-red-400'
                      }`}>
                        {trade.realizedPnl !== null && trade.realizedPnl !== undefined ? (
                          <>
                            ${formatNumber(Math.abs(trade.realizedPnl), 2)}
                            {trade.realizedPnlPercent !== null && (
                              <> ({trade.realizedPnlPercent >= 0 ? '+' : ''}{formatPercent(trade.realizedPnlPercent / 100)})</>
                            )}
                          </>
                        ) : '-'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* History Tab */}
      {activeTab === 'history' && (
        <div className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/30">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium">Date</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">Total Value</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">Total Cost</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">Total PnL</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">PnL %</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">Open</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">Closed</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">Win Rate</th>
                </tr>
              </thead>
              <tbody>
                {portfolioHistory.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-6 text-center text-muted-foreground">
                      No portfolio history yet
                    </td>
                  </tr>
                ) : (
                  portfolioHistory.map((snapshot) => (
                    <tr key={snapshot.id} className="border-t border-border hover:bg-muted/50">
                      <td className="px-4 py-3 text-sm">
                        {formatDate(new Date(snapshot.timestamp))}
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-mono">
                        ${formatNumber(Number(snapshot.totalValueUsd), 2)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-mono">
                        ${formatNumber(Number(snapshot.totalCostUsd), 2)}
                      </td>
                      <td className={`px-4 py-3 text-right text-sm font-mono ${
                        Number(snapshot.totalPnlUsd) >= 0 ? 'text-green-400' : 'text-red-400'
                      }`}>
                        ${formatNumber(Math.abs(Number(snapshot.totalPnlUsd)), 2)}
                      </td>
                      <td className={`px-4 py-3 text-right text-sm font-mono ${
                        Number(snapshot.totalPnlPercent) >= 0 ? 'text-green-400' : 'text-red-400'
                      }`}>
                        {Number(snapshot.totalPnlPercent) >= 0 ? '+' : ''}{formatPercent(Number(snapshot.totalPnlPercent) / 100)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm">
                        {snapshot.openPositions}
                      </td>
                      <td className="px-4 py-3 text-right text-sm">
                        {snapshot.closedPositions}
                      </td>
                      <td className="px-4 py-3 text-right text-sm">
                        {snapshot.winRate ? formatPercent(Number(snapshot.winRate)) : 'N/A'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
