'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { fetchPaperTradingPortfolio, fetchPaperTrades, fetchPaperPortfolioHistory, fetchConsensusTrades, fetchSignals, fetchConsensusSignals } from '@/lib/api';
import { formatNumber, formatPercent, formatDate } from '@/lib/utils';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

export default function PaperTradingPage() {
  const [portfolio, setPortfolio] = useState<any>(null);
  const [trades, setTrades] = useState<any[]>([]);
  const [portfolioHistory, setPortfolioHistory] = useState<any[]>([]);
  const [consensusTrades, setConsensusTrades] = useState<any[]>([]);
  const [signals, setSignals] = useState<any[]>([]);
  const [consensusSignals, setConsensusSignals] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'trades' | 'history'>('overview');

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    try {
      const [portfolioData, tradesData, historyData, consensusData] = await Promise.all([
        fetchPaperTradingPortfolio().catch((err) => {
          console.error('Error fetching portfolio:', err);
          return { 
            totalValueUsd: 1000, 
            totalCostUsd: 0, 
            totalPnlUsd: 0, 
            totalPnlPercent: 0, 
            openPositions: 0, 
            closedPositions: 0, 
            winRate: null, 
            totalTrades: 0,
            initialCapital: 1000
          };
        }),
        fetchPaperTrades({ limit: 100 }).catch((err) => {
          console.error('Error fetching trades:', err);
          return { trades: [] };
        }),
        fetchPaperPortfolioHistory(100).catch((err) => {
          console.error('Error fetching history:', err);
          return { snapshots: [] };
        }),
        fetchConsensusTrades(2).catch(() => ({ consensusTrades: [] })),
      ]);
      
      // Fetch signals separately
      const signalsData = await fetchSignals({ limit: 100 }).catch(() => ({ signals: [] }));
      const consensusSignalsData = await fetchConsensusSignals(100).catch(() => ({ signals: [] }));
      setPortfolio(portfolioData);
      setTrades(tradesData.trades || []);
      setPortfolioHistory(historyData.snapshots || []);
      setConsensusTrades(consensusData.consensusTrades || []);
      setSignals(signalsData.signals || []);
      setConsensusSignals(consensusSignalsData.signals || []);
    } catch (error) {
      console.error('Error loading paper trading data:', error);
      // Set default values on error
      setPortfolio({ 
        totalValueUsd: 1000, 
        totalCostUsd: 0, 
        totalPnlUsd: 0, 
        totalPnlPercent: 0, 
        openPositions: 0, 
        closedPositions: 0, 
        winRate: null, 
        totalTrades: 0,
        initialCapital: 1000
      });
      setTrades([]);
      setPortfolioHistory([]);
      setConsensusTrades([]);
      setSignals([]);
      setConsensusSignals([]);
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
  // Opravit výpočet winning/losing trades - použít realizedPnl, ale jen pokud je nastavené
  const winningTrades = closedTrades.filter(t => {
    const pnl = t.realizedPnl;
    return pnl !== null && pnl !== undefined && Number(pnl) > 0;
  });
  const losingTrades = closedTrades.filter(t => {
    const pnl = t.realizedPnl;
    return pnl !== null && pnl !== undefined && Number(pnl) < 0;
  });
  const winRate = closedTrades.length > 0 ? (winningTrades.length / closedTrades.length) * 100 : null;

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-4xl font-bold mb-4">Paper Trading</h1>
      <p className="text-muted-foreground mb-8">
        Sandbox pro testování strategií bez rizika reálných peněz. Základní kapitál: $1,000 USD
      </p>

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
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
              <div className="bg-muted/30 rounded-lg p-4">
                <div className="text-sm text-muted-foreground">Initial Capital</div>
                <div className="text-2xl font-bold">${formatNumber(portfolio.initialCapital || 1000, 2)}</div>
              </div>
              <div className="bg-muted/30 rounded-lg p-4">
                <div className="text-sm text-muted-foreground">Total Value</div>
                <div className="text-2xl font-bold">${formatNumber(portfolio.totalValueUsd, 2)}</div>
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
                  {portfolio.winRate ? formatPercent(portfolio.winRate) : winRate !== null ? formatPercent(winRate / 100) : 'N/A'}
                </div>
              </div>
            </div>
          )}

          {/* Trading Stats */}
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
            <div className="bg-muted/30 rounded-lg p-4">
              <div className="text-sm text-muted-foreground">Total Trades</div>
              <div className="text-2xl font-bold">{portfolio?.totalTrades || trades.length}</div>
            </div>
            <div className="bg-muted/30 rounded-lg p-4">
              <div className="text-sm text-muted-foreground">Open Positions</div>
              <div className="text-2xl font-bold">{portfolio?.openPositions || openTrades.length}</div>
            </div>
            <div className="bg-muted/30 rounded-lg p-4">
              <div className="text-sm text-muted-foreground">Closed Positions</div>
              <div className="text-2xl font-bold">{portfolio?.closedPositions || closedTrades.length}</div>
            </div>
            <div className="bg-green-500/20 rounded-lg p-4">
              <div className="text-sm text-muted-foreground">Winning Trades</div>
              <div className="text-2xl font-bold text-green-400">{winningTrades.length}</div>
            </div>
            <div className="bg-red-500/20 rounded-lg p-4">
              <div className="text-sm text-muted-foreground">Losing Trades</div>
              <div className="text-2xl font-bold text-red-400">{losingTrades.length}</div>
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
                  cost: Number(s.totalCostUsd),
                }))}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="timestamp" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="value" stroke="#8884d8" name="Portfolio Value (USD)" />
                  <Line type="monotone" dataKey="pnl" stroke="#82ca9d" name="Total PnL (USD)" />
                  <Line type="monotone" dataKey="cost" stroke="#ffc658" name="Total Cost (USD)" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {portfolioHistory.length === 0 && (
            <div className="bg-muted/30 rounded-lg p-8 text-center">
              <p className="text-muted-foreground">No portfolio history yet. Start paper trading to see performance over time.</p>
            </div>
          )}
          </div>
      )}

      {/* Trades Tab */}
      {activeTab === 'trades' && (
        <div className="space-y-4">
          <div className="flex gap-4 mb-4">
            <span className="px-4 py-2 bg-primary text-primary-foreground rounded">
              Signals ({consensusSignals.length})
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/30">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium">Date</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Token</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Wallets</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">First Trade</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">Latest Trade</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">Trades</th>
                </tr>
              </thead>
              <tbody>
                {consensusSignals.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                      No consensus signals yet. Signals are generated when 2+ wallets buy the same token within 2 hours.
                    </td>
                  </tr>
                ) : (
                  consensusSignals.map((signal) => {
                    const trades = signal.trades || [];
                    const firstTrade = trades.length > 0 ? trades[trades.length - 1] : null;
                    const latestTrade = trades.length > 0 ? trades[0] : null;
                    
                    return (
                      <tr key={signal.id} className="border-t border-border hover:bg-muted/50">
                        <td className="px-4 py-3 text-sm">
                          {formatDate(new Date(signal.createdAt))}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {signal.token?.mintAddress ? (
                            <Link
                              href={`https://birdeye.so/solana/token/${signal.token.mintAddress}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline"
                            >
                              {signal.token?.symbol ? `$${signal.token.symbol}` : signal.token?.name || signal.tokenId.substring(0, 8) + '...'}
                            </Link>
                          ) : (
                            signal.token?.symbol ? `$${signal.token.symbol}` : signal.token?.name || '-'
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {signal.walletCount} wallet{signal.walletCount > 1 ? 's' : ''}
                        </td>
                        <td className="px-4 py-3 text-right text-sm text-muted-foreground">
                          {firstTrade ? formatDate(new Date(firstTrade.timestamp)) : '-'}
                        </td>
                        <td className="px-4 py-3 text-right text-sm text-muted-foreground">
                          {latestTrade ? formatDate(new Date(latestTrade.timestamp)) : '-'}
                        </td>
                        <td className="px-4 py-3 text-right text-sm">
                          {trades.length} trade{trades.length > 1 ? 's' : ''}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
                    const model = trade.meta?.model || 'basic';
                    const riskLevel = trade.meta?.riskLevel || 'medium';
                    const positionSizePercent = trade.meta?.positionSizePercent || 5;
                    
                    return (
                      <tr key={trade.id} className="border-t border-border hover:bg-muted/50">
                        <td className="px-4 py-3 text-sm">
                          {formatDate(new Date(trade.timestamp))}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {trade.wallet?.id ? (
                            <Link 
                              href={`/wallets/${trade.wallet.id}`}
                              className="text-primary hover:underline"
                            >
                              {trade.wallet?.label || trade.wallet?.address?.substring(0, 8) || '-'}
                            </Link>
                          ) : (
                            trade.wallet?.label || trade.wallet?.address?.substring(0, 8) || '-'
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {trade.token?.mintAddress ? (
            <Link
                              href={`https://birdeye.so/solana/token/${trade.token.mintAddress}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline"
                            >
                              {trade.token?.symbol ? `$${trade.token.symbol}` : trade.token?.name || trade.tokenId.substring(0, 8) + '...'}
            </Link>
                          ) : (
                            trade.token?.symbol ? `$${trade.token.symbol}` : trade.token?.name || '-'
                          )}
                        </td>
                        <td className="px-4 py-3 text-right text-sm">
                          <span className={`px-2 py-1 rounded text-xs font-semibold ${
                            trade.side === 'buy' 
                              ? 'bg-green-500/20 text-green-400' 
                              : 'bg-red-500/20 text-red-400'
                          }`}>
                            {trade.side.toUpperCase()}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-mono">
                          {formatNumber(trade.amountToken, 6)}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-mono">
                          ${formatNumber(trade.priceBasePerToken, 6)}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-mono">
                          ${formatNumber(trade.amountBase, 2)} ({positionSizePercent}%)
                        </td>
                        <td className="px-4 py-3 text-right text-sm">
                          <span className={`px-2 py-1 rounded text-xs ${
                            model === 'consensus' ? 'bg-purple-500/20 text-purple-400' :
                            model === 'smart-copy' ? 'bg-blue-500/20 text-blue-400' :
                            'bg-gray-500/20 text-gray-400'
                          }`}>
                            {model === 'consensus' ? 'Consensus' : model === 'smart-copy' ? 'Smart Copy' : 'Basic'}
                          </span>
                          {riskLevel && (
                            <span className={`ml-1 px-1 py-0.5 rounded text-xs ${
                              riskLevel === 'low' ? 'bg-green-500/20 text-green-400' :
                              riskLevel === 'medium' ? 'bg-yellow-500/20 text-yellow-400' :
                              'bg-red-500/20 text-red-400'
                            }`}>
                              {riskLevel}
                            </span>
                          )}
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
                    );
                  })
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

      {/* Signals Table - Paper Trading History */}
      <div className="mt-8 space-y-4">
        <h2 className="text-2xl font-bold">Paper Trading History</h2>
        <p className="text-muted-foreground text-sm mb-4">
          Přehled všech nákupů a prodejů v rámci paper tradingu
        </p>

        {signals.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            No signals yet. Signals are generated automatically when consensus trades are executed.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left p-4">Type</th>
                  <th className="text-left p-4">Token</th>
                  <th className="text-left p-4">Price</th>
                  <th className="text-left p-4">Amount</th>
                  <th className="text-left p-4">Quality Score</th>
                  <th className="text-left p-4">Risk</th>
                  <th className="text-left p-4">Model</th>
                  <th className="text-left p-4">Time</th>
                  <th className="text-left p-4">Status</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((signal) => {
                  const riskColor = 
                    signal.riskLevel === 'low' ? 'text-green-400' :
                    signal.riskLevel === 'medium' ? 'text-yellow-400' :
                    signal.riskLevel === 'high' ? 'text-red-400' : 'text-muted-foreground';

                  return (
                    <tr key={signal.id} className="border-b border-border/50 hover:bg-muted/30">
                      <td className="p-4">
                        <span className={`px-2 py-1 rounded text-sm font-semibold ${
                          signal.type === 'buy' 
                            ? 'bg-green-500/20 text-green-400' 
                            : 'bg-red-500/20 text-red-400'
                        }`}>
                          {signal.type.toUpperCase()}
                        </span>
                      </td>
                      <td className="p-4 font-mono text-sm">
                        {signal.tokenId?.substring(0, 16) || '-'}...
                      </td>
                      <td className="p-4">
                        ${formatNumber(signal.priceBasePerToken || 0, 6)}
                      </td>
                      <td className="p-4">
                        {formatNumber(signal.amountToken || 0, 4)} tokens
                        <br />
                        <span className="text-xs text-muted-foreground">
                          ${formatNumber(signal.amountBase || 0, 2)}
                        </span>
                      </td>
                      <td className="p-4">
                        {signal.qualityScore !== null && signal.qualityScore !== undefined ? (
                          <span className={signal.qualityScore >= 70 ? 'text-green-400' : signal.qualityScore >= 40 ? 'text-yellow-400' : 'text-red-400'}>
                            {signal.qualityScore.toFixed(1)}/100
                          </span>
                        ) : (
                          <span className="text-muted-foreground">N/A</span>
                        )}
                      </td>
                      <td className={`p-4 ${riskColor}`}>
                        {signal.riskLevel ? signal.riskLevel.toUpperCase() : 'N/A'}
                      </td>
                      <td className="p-4 text-sm text-muted-foreground">
                        {signal.model || 'N/A'}
                      </td>
                      <td className="p-4 text-sm text-muted-foreground">
                        {formatDate(signal.timestamp)}
                      </td>
                      <td className="p-4">
                        <span className={`px-2 py-1 rounded text-xs ${
                          signal.status === 'active' 
                            ? 'bg-green-500/20 text-green-400' 
                            : signal.status === 'executed'
                            ? 'bg-blue-500/20 text-blue-400'
                            : 'bg-muted text-muted-foreground'
                        }`}>
                          {signal.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
