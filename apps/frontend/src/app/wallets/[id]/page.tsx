'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { fetchSmartWallet, fetchTrades, fetchWalletPnl, fetchWalletPortfolio, fetchWalletPortfolioRefresh, deletePosition } from '@/lib/api';
import { formatAddress, formatPercent, formatNumber, formatDate, copyToClipboard, formatMultiplier, formatDateTimeCZ, formatHoldTime } from '@/lib/utils';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import type { SmartWallet, Trade } from '@solbot/shared';

export default function WalletDetailPage() {
  const params = useParams();
  const walletId = params.id as string;
  
  const [wallet, setWallet] = useState<any>(null);
  const [trades, setTrades] = useState<{ trades: Trade[]; total: number } | null>(null);
  const [pnlData, setPnlData] = useState<any>(null);
  const [portfolio, setPortfolio] = useState<any>(null);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [portfolioLoaded, setPortfolioLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tokenFilter, setTokenFilter] = useState<string>('');
  const [timeframeFilter, setTimeframeFilter] = useState<string>('all');
  const [pnlTimeframe, setPnlTimeframe] = useState<'7d' | '30d' | '90d' | '1y'>('30d');
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [activeTab, setActiveTab] = useState<'basic' | 'advanced'>('basic');
  const [showAllClosedPositions, setShowAllClosedPositions] = useState(false);
  const [portfolioRefreshing, setPortfolioRefreshing] = useState(false);
  const [portfolioRefreshMsg, setPortfolioRefreshMsg] = useState<{ type: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [deletingPosition, setDeletingPosition] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!walletId) return;
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
      // Portfolio is loaded lazily - don't block initial page load
      const [walletData, tradesData, pnl] = await Promise.all([
        fetchSmartWallet(walletId),
        fetchTrades(walletId, { 
          page: 1, 
          pageSize: 200,
          tokenId: tokenFilter || undefined,
          fromDate,
        }),
        fetchWalletPnl(walletId).catch(() => null), // PnL data is optional
      ]);
      setWallet(walletData);
      setTrades(tradesData);
      setPnlData(pnl);
      
      // Load portfolio in background (non-blocking)
      loadPortfolioLazy();
    } catch (error) {
      console.error('Error loading wallet data:', error);
    } finally {
      setLoading(false);
    }
  }, [walletId, timeframeFilter, tokenFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function loadPortfolioLazy() {
    if (portfolioLoaded || portfolioLoading) return;
    
    setPortfolioLoading(true);
    try {
      const portfolioData = await fetchWalletPortfolio(walletId).catch(() => null);
      setPortfolio(portfolioData);
      setPortfolioLoaded(true);
    } catch (error) {
      console.error('Error loading portfolio:', error);
    } finally {
      setPortfolioLoading(false);
    }
  }

  async function loadPortfolio() {
    if (!walletId) return;
    setPortfolioLoading(true);
    try {
      const portfolioData = await fetchWalletPortfolio(walletId, true).catch(() => null);
      setPortfolio(portfolioData);
      setPortfolioLoaded(true);
    } catch (error) {
      console.error('Error loading portfolio:', error);
    } finally {
      setPortfolioLoading(false);
    }
  }

  async function refreshPortfolio() {
    if (!walletId) return;
    try {
      setPortfolioRefreshing(true);
      // Step 1: Refresh portfolio (this saves to PortfolioBaseline)
      await fetchWalletPortfolioRefresh(walletId);
      
      // Step 2: Reload portfolio from baseline (to ensure we have the saved version)
      // Wait a bit to ensure database write is complete
      await new Promise(resolve => setTimeout(resolve, 500));
      const refreshed = await fetchWalletPortfolio(walletId);
      
      // Basic validation: structure
      if (!refreshed || typeof refreshed !== 'object') {
        throw new Error('Empty response');
      }

      setPortfolio(refreshed);
      setPortfolioRefreshMsg({ type: 'success', text: 'Portfolio refreshed and saved.' });
    } catch (error: any) {
      console.error('Failed to refresh portfolio:', error);
      const msg = error?.message || 'Failed to refresh portfolio. Try again.';
      setPortfolioRefreshMsg({ type: 'error', text: msg });
    } finally {
      setPortfolioRefreshing(false);
      // Auto hide message after 4s
      setTimeout(() => setPortfolioRefreshMsg(null), 4000);
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

  const advancedStats = wallet.advancedStats;
  const scoreBreakdown = advancedStats?.scoreBreakdown;
  const rollingEntries =
    advancedStats?.rolling
      ? (['7d', '30d', '90d'] as const)
          .map((label) => ({
            label,
            stats: advancedStats.rolling?.[label],
          }))
          .filter((entry) => entry.stats)
      : [];
  const behaviourStats = advancedStats?.behaviour;
  const hasLegacyStats =
    !!advancedStats &&
    typeof advancedStats.profitFactor === 'number';

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="container mx-auto">
        <Link 
          href="/wallets" 
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

        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-2">
            <h1 className="mb-0">
            {wallet.label || formatAddress(wallet.address)}
          </h1>
            <button
              onClick={async () => {
                const success = await copyToClipboard(wallet.address);
                if (success) {
                  setCopiedAddress(true);
                  setTimeout(() => setCopiedAddress(false), 2000);
                }
              }}
              className="text-muted-foreground hover:text-foreground"
              title="Copy address"
            >
              {copiedAddress ? (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M13.5 4.5L6 12L2.5 8.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="5.5" y="5.5" width="8" height="8" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                  <rect x="2.5" y="2.5" width="8" height="8" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                </svg>
              )}
            </button>
            {wallet.twitterUrl && (
              <a
                href={wallet.twitterUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground"
                title="X (Twitter) profile"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12.6 2h1.8L10.2 6.8L14.8 14H10.4L7.4 9.2L4 14H2.2L5.8 8.8L1.4 2H5.8L8.6 6.4L12.6 2ZM11.8 12.4H12.8L4.2 3.2H3.1L11.8 12.4Z" fill="currentColor"/>
                </svg>
              </a>
            )}
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

        {/* Tabs */}
        <div className="flex gap-2 mb-6 border-b border-border">
          <button
            onClick={() => setActiveTab('basic')}
            className={`px-4 py-2 font-medium ${
              activeTab === 'basic'
                ? 'border-b-2 border-white text-white'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Basic
          </button>
          <button
            onClick={() => setActiveTab('advanced')}
            className={`px-4 py-2 font-medium ${
              activeTab === 'advanced'
                ? 'border-b-2 border-white text-white'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Advanced
          </button>
        </div>

        {/* Basic Tab */}
        {activeTab === 'basic' && (
          <>
        {/* Metrics Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div style={{ border: 'none', background: '#2323234f', backdropFilter: 'blur(20px)' }} className="p-4">
            <div style={{ color: 'white', fontSize: '.875rem', textTransform: 'uppercase', letterSpacing: '0.03em', fontWeight: 'bold' }} className="mb-1">Score</div>
            <div style={{ fontSize: '1.5rem', fontFamily: 'Inter, sans-serif', fontWeight: 'normal' }} className="text-white">{formatNumber(wallet.score, 1)}</div>
          </div>
          <div style={{ border: 'none', background: '#2323234f', backdropFilter: 'blur(20px)' }} className="p-4">
            <div style={{ color: 'white', fontSize: '.875rem', textTransform: 'uppercase', letterSpacing: '0.03em', fontWeight: 'bold' }} className="mb-1">Total Trades</div>
            <div style={{ fontSize: '1.5rem', fontFamily: 'Inter, sans-serif', fontWeight: 'normal' }} className="text-white">{wallet.totalTrades}</div>
          </div>
          <div style={{ border: 'none', background: '#2323234f', backdropFilter: 'blur(20px)' }} className="p-4">
            <div style={{ color: 'white', fontSize: '.875rem', textTransform: 'uppercase', letterSpacing: '0.03em', fontWeight: 'bold' }} className="mb-1">Win Rate</div>
            <div style={{ fontSize: '1.5rem', fontFamily: 'Inter, sans-serif', fontWeight: 'normal' }} className="text-white">{formatPercent(wallet.winRate)}</div>
          </div>
          <div style={{ border: 'none', background: '#2323234f', backdropFilter: 'blur(20px)' }} className="p-4">
            <div style={{ color: 'white', fontSize: '.875rem', textTransform: 'uppercase', letterSpacing: '0.03em', fontWeight: 'bold' }} className="mb-1">Avg Hold Time</div>
            <div style={{ fontSize: '1.5rem', fontFamily: 'Inter, sans-serif', fontWeight: 'normal' }} className="text-white">
              {wallet.avgHoldingTimeMin > 0 
                ? `${formatNumber(wallet.avgHoldingTimeMin, 0)} min`
                : '-'
              }
            </div>
          </div>
        </div>

        {/* PnL Periods Overview */}
        {pnlData && pnlData.periods && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            {(['1d', '7d', '14d', '30d'] as const).map((period) => {
              const data = pnlData.periods[period];
              if (!data) return null;
              return (
                <div key={period} style={{ border: 'none', background: '#2323234f', backdropFilter: 'blur(20px)' }} className="p-4">
                  <div style={{ color: 'white', fontSize: '.875rem', textTransform: 'uppercase', letterSpacing: '0.03em', fontWeight: 'bold' }} className="mb-1">PnL ({period})</div>
                  <div className={`${
                    data.pnlPercent >= 0 ? 'text-green-600' : 'text-red-600'
                  }`}>
                    {data.pnlUsd !== undefined && data.pnlUsd !== null
                      ? (
                        <>
                          <span style={{ fontSize: '1.5rem', fontFamily: 'Inter, sans-serif', fontWeight: 'normal' }}>
                            ${formatNumber(Math.abs(data.pnlUsd), 2)}
                          </span>
                          {' '}
                          <span style={{ fontSize: '0.875rem', fontFamily: 'Inter, sans-serif', fontWeight: 'normal' }}>
                            ({data.pnlPercent >= 0 ? '+' : ''}{formatPercent(data.pnlPercent / 100)})
                          </span>
                        </>
                      )
                      : `${data.pnlPercent >= 0 ? '+' : ''}${formatPercent(data.pnlPercent / 100)}`
                    }
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {data.trades} trades
                  </div>
                </div>
              );
            })}
          </div>
        )}

            {/* Portfolio - DISABLED/TEMPORARILY COMMENTED OUT */}
            {/* {portfolio && (
              <div className="grid grid-cols-2 gap-4 mb-8">
                Portfolio section disabled
              </div>
            )} */}

            {/* Closed Positions */}
            {portfolioLoading && (
              <div className="mb-8 text-center text-muted-foreground py-8">
                Loading positions...
              </div>
            )}
            {!portfolioLoading && !portfolio && !portfolioLoaded && (
              <div className="mb-8 text-center py-8">
                <button
                  onClick={loadPortfolioLazy}
                  className="px-6 py-3 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
                >
                  Load Positions
                </button>
                <p className="text-sm text-muted-foreground mt-2">
                  Positions are loaded on-demand to improve page load speed
                </p>
              </div>
            )}
            {portfolio && (
              <div className="mb-8 w-full">
                {/* Closed Positions */}
                <div className="overflow-hidden w-full">
                  <h2 style={{ fontSize: '2rem', marginBottom: '1rem' }} className="font-semibold">
                    Closed Positions
                  </h2>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="bg-muted/30">
                        <tr>
                          <th className="px-4 py-3 text-left text-sm font-medium">TOKEN</th>
                          <th className="px-4 py-3 text-right text-sm font-medium">SOLD</th>
                          <th className="px-4 py-3 text-right text-sm font-medium">PnL</th>
                          <th className="px-4 py-3 text-right text-sm font-medium">HOLD TIME</th>
                          <th className="px-4 py-3 text-right text-sm font-medium">ACTIONS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(() => {
                          const closedPositions = portfolio.closedPositions || [];

                          if (closedPositions.length === 0) {
                            return (
                              <tr className="border-t border-border">
                                <td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">
                                  No closed positions
                                </td>
                              </tr>
                            );
                          }

                          return closedPositions
                            .slice(0, showAllClosedPositions ? closedPositions.length : 10)
                            .map((position: any, index: number) => {
                              const token = position.token;
                              const totalSold = position.totalSold || 0;
                              const closedPnl = position.closedPnl || 0;
                              const closedPnlPercent = position.closedPnlPercent || 0;
                              const holdTimeMinutes = position.holdTimeMinutes;
                              const sequenceNumber = position.sequenceNumber ?? null;
                              const positionKey = sequenceNumber 
                                ? `${position.tokenId}-${sequenceNumber}` 
                                : `${position.tokenId}-${index}`;
                              const isDeleting = deletingPosition === positionKey;
                              
                              const handleDelete = async () => {
                                if (!confirm(`Are you sure you want to delete this closed trade? This will permanently delete the trade and all related data.`)) {
                                  return;
                                }
                                
                                setDeletingPosition(positionKey);
                                try {
                                  await deletePosition(walletId, position.tokenId, sequenceNumber || undefined);
                                  // Reload portfolio data
                                  await loadPortfolio();
                                  setPortfolioRefreshMsg({ type: 'success', text: 'Closed trade deleted successfully' });
                                  setTimeout(() => setPortfolioRefreshMsg(null), 3000);
                                } catch (error: any) {
                                  console.error('Failed to delete position:', error);
                                  setPortfolioRefreshMsg({ type: 'error', text: error.message || 'Failed to delete closed trade' });
                                  setTimeout(() => setPortfolioRefreshMsg(null), 5000);
                                } finally {
                                  setDeletingPosition(null);
                                }
                              };
                              
                              return (
                                <tr key={positionKey} className="border-t border-border hover:bg-muted/50">
                                  <td className="px-4 py-3 text-sm">
                                    {token?.mintAddress ? (
                                      <a
                                        href={`https://solscan.io/token/${token.mintAddress}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-white hover:opacity-80 hover:underline"
                                      >
                                        {token.symbol 
                                          ? `$${token.symbol}` 
                                          : token.name 
                                          ? token.name 
                                          : `${token.mintAddress.slice(0, 8)}...${token.mintAddress.slice(-8)}`}
                                      </a>
                                    ) : (
                                      <span className="text-muted-foreground">-</span>
                                    )}
                                  </td>
                                  <td className="px-4 py-3 text-right text-sm font-mono">
                                    {formatNumber(totalSold, 6)}
                                  </td>
                                  <td className={`px-4 py-3 text-right text-sm font-mono ${
                                    closedPnl >= 0 ? 'text-green-400' : 'text-red-400'
                                  }`}>
                                    {closedPnl !== null && closedPnl !== undefined ? (
                                      <>
                                        ${formatNumber(Math.abs(closedPnl), 2)} ({closedPnlPercent >= 0 ? '+' : ''}{formatPercent(closedPnlPercent / 100)})
                                      </>
                                    ) : '-'}
                                  </td>
                                  <td className="px-4 py-3 text-right text-sm font-mono">
                                    {holdTimeMinutes !== null && holdTimeMinutes !== undefined
                                      ? formatHoldTime(holdTimeMinutes)
                                      : '-'}
                                  </td>
                                  <td className="px-4 py-3 text-right">
                                    <button
                                      onClick={handleDelete}
                                      disabled={isDeleting}
                                      className="text-red-400 hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed text-sm px-2 py-1 rounded hover:bg-red-400/10 transition-colors"
                                      title="Delete this closed trade"
                                    >
                                      {isDeleting ? 'Deleting...' : (
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                        </svg>
                                      )}
                                    </button>
                                  </td>
                                </tr>
                              );
                            });
                        })()}
                      </tbody>
                    </table>
                  </div>
                  {(() => {
                    const closedPositions = portfolio.closedPositions || [];
                    if (closedPositions.length > 10) {
                      return (
                        <div className="mt-4 text-center">
                        <button
                            onClick={() => setShowAllClosedPositions(!showAllClosedPositions)}
                          className="text-sm text-muted-foreground hover:text-foreground"
                        >
                            {showAllClosedPositions ? 'Show Less' : `Show More (${closedPositions.length - 10} more)`}
                        </button>
                      </div>
                    );
                    }
                    return null;
                  })()}
                </div>
              </div>
            )}

            {/* Recent Trades */}
            <div className="overflow-hidden">
              <h2 style={{ fontSize: '2rem', marginBottom: '1rem' }} className="font-semibold">Recent Trades</h2>
              
              {/* Filters */}
              <div className="flex gap-4 flex-wrap mb-4">
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
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-muted">
                    <tr>
                      <th className="px-4 py-3 text-left text-sm font-medium">DATE</th>
                      <th className="px-4 py-3 text-center text-sm font-medium">TYPE</th>
                      <th className="px-4 py-3 text-left text-sm font-medium">TOKEN</th>
                      <th className="px-4 py-3 text-right text-sm font-medium">Value</th>
                      <th className="px-4 py-3 text-right text-sm font-medium">PRICE</th>
                      <th className="px-4 py-3 text-right text-sm font-medium">AMOUNT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const allTrades = [...(trades?.trades || [])].sort(
                        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
                      );
                      const recentTrades = allTrades.slice(-10).reverse();
                      
                      return recentTrades.map((trade) => {
                        const side = (trade.side || '').toLowerCase();
                        const isBuy = side === 'buy';
                        const isVoid = side === 'void';
                        return (
                          <tr key={trade.id} className="border-t border-border hover:bg-muted/50">
                            <td className="px-4 py-3 text-sm">
                              <a
                                href={`https://solscan.io/tx/${trade.txSignature}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-400 hover:text-blue-300 hover:underline text-muted-foreground"
                              >
                                {formatDate(trade.timestamp)}
                              </a>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span
                                className={`px-2 py-1 rounded text-xs font-medium ${
                                  isVoid 
                                    ? 'bg-purple-500/20 text-purple-400' 
                                    : isBuy 
                                  ? 'bg-green-500/20 text-green-400'
                                  : 'bg-red-500/20 text-red-400'
                                }`}
                              >
                                {isVoid ? 'VOID' : isBuy ? 'BUY' : 'SELL'}
                              </span>
                          </td>
                          <td className="px-4 py-3 text-sm">
                            {trade.token?.mintAddress ? (
                              <a
                                href={`https://solscan.io/token/${trade.token.mintAddress}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-white hover:opacity-80 hover:underline"
                              >
                                {trade.token.symbol 
                                  ? `$${trade.token.symbol}` 
                                  : trade.token.name 
                                  ? trade.token.name 
                                  : `${trade.token.mintAddress.slice(0, 6)}...${trade.token.mintAddress.slice(-6)}`}
                              </a>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </td>
                            <td
                              className={`px-4 py-3 text-right text-sm font-mono ${
                                isVoid 
                                  ? 'text-purple-400' 
                                  : isBuy 
                                  ? 'text-green-400' 
                                  : 'text-red-400'
                              }`}
                            >
                              {isVoid 
                                ? 'void' 
                                : trade.valueUsd
                                ? `$${formatNumber(Number(trade.valueUsd), 2)}`
                                : trade.amountBase
                                ? `$${formatNumber(Number(trade.amountBase), 2)}`
                                : '-'}
                          </td>
                            <td
                              className={`px-4 py-3 text-right text-sm font-mono ${
                                isVoid 
                                  ? 'text-purple-400' 
                                  : isBuy 
                                  ? 'text-green-400' 
                                  : 'text-red-400'
                              }`}
                            >
                            {isVoid ? '-' : `$${formatNumber(Number(trade.priceBasePerToken), 6)}`}
                          </td>
                            <td
                              className={`px-4 py-3 text-right text-sm font-mono ${
                                isVoid 
                                  ? 'text-purple-400' 
                                  : isBuy 
                                  ? 'text-green-400' 
                                  : 'text-red-400'
                              }`}
                            >
                              {isVoid ? '-' : `$${formatNumber(Number(trade.amountBase), 6)}`}
                          </td>
                        </tr>
                      );
                    });
                    })()}
                  </tbody>
                </table>
              </div>
              {(!trades || trades.trades.length === 0) && (
                <div className="text-center py-12 text-muted-foreground">
                  No trades found
                </div>
              )}
            </div>
          </>
        )}

        {/* Advanced Tab */}
        {activeTab === 'advanced' && (
          <>
            {scoreBreakdown && (
              <div className="border border-border rounded-lg p-6 mb-8">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Smart Score</div>
                    <div className="text-3xl font-bold">{formatNumber(scoreBreakdown.smartScore, 1)}</div>
                    {typeof scoreBreakdown.legacyScore === 'number' && (
                      <div className="text-xs text-muted-foreground mt-1">
                        Legacy score: {formatNumber(scoreBreakdown.legacyScore, 1)}
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-4 flex-1">
                    {[
                      { label: 'Profitability', value: scoreBreakdown.profitabilityScore },
                      { label: 'Consistency', value: scoreBreakdown.consistencyScore },
                      { label: 'Risk', value: scoreBreakdown.riskScore },
                      { label: 'Behaviour', value: scoreBreakdown.behaviourScore },
                      { label: 'Sample Factor', value: scoreBreakdown.sampleFactor * 100, isPercent: true },
                    ].map((item) => (
                      <div key={item.label} className="border border-border rounded-md p-3 text-center">
                        <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
                          {item.label}
                        </div>
                        <div className="text-lg font-semibold">
                          {item.isPercent ? `${item.value.toFixed(0)}%` : formatNumber(item.value, 0)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {rollingEntries.length > 0 && (
              <div className="border border-border rounded-lg p-6 mb-8">
                <h2 className="text-lg font-semibold mb-4">Rolling Performance</h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="text-left py-2">Window</th>
                        <th className="text-right py-2">PnL (USD)</th>
                        <th className="text-right py-2">ROI</th>
                        <th className="text-right py-2">Win Rate</th>
                        <th className="text-right py-2">Trades</th>
                        <th className="text-right py-2">Median ROI</th>
                        <th className="text-right py-2">Max Drawdown</th>
                        <th className="text-right py-2">Volatility</th>
                        <th className="text-right py-2">Avg Hold (W/L)</th>
                        <th className="text-right py-2">Avg Trade Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rollingEntries.map(({ label, stats }) => {
                        if (!stats) return null;
                        return (
                          <tr key={label} className="border-b border-border">
                            <td className="py-2 font-medium uppercase">{label}</td>
                            <td className={`text-right py-2 ${stats.realizedPnlUsd >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {stats.realizedPnlUsd >= 0 ? '+' : ''}
                              ${formatNumber(stats.realizedPnlUsd, 2)}
                            </td>
                            <td className="text-right py-2">
                              {formatPercent((stats.realizedRoiPercent ?? 0) / 100)}
                            </td>
                            <td className="text-right py-2">{formatPercent(stats.winRate ?? 0)}</td>
                            <td className="text-right py-2">{stats.numClosedTrades}</td>
                            <td className="text-right py-2">
                              {formatPercent((stats.medianTradeRoiPercent ?? 0) / 100)}
                            </td>
                            <td className="text-right py-2">
                              {formatPercent((Math.abs(stats.maxDrawdownPercent ?? 0)) / 100)}
                            </td>
                            <td className="text-right py-2">
                              {formatPercent((stats.volatilityPercent ?? 0) / 100)}
                            </td>
                            <td className="text-right py-2 text-xs">
                              {formatHoldTime(stats.medianHoldMinutesWinners)}
                              {' / '}
                              {formatHoldTime(stats.medianHoldMinutesLosers)}
                            </td>
                            <td className="text-right py-2">
                              ${formatNumber(stats.avgTradeSizeUsd ?? 0, 2)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {behaviourStats && (
              <div className="border border-border rounded-lg p-6 mb-8">
                <h2 className="text-lg font-semibold mb-4">Behaviour Signals</h2>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Low Liquidity Trades</div>
                    <div className="text-xl font-bold">
                      {formatPercent(behaviourStats.shareLowLiquidity ?? 0)}
                    </div>
                    <div className="text-xs text-muted-foreground">under $10k liquidity</div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">New Token Entries</div>
                    <div className="text-xl font-bold">
                      {formatPercent(behaviourStats.shareNewTokens ?? 0)}
                    </div>
                    <div className="text-xs text-muted-foreground">token age &lt; 30 min</div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Avg. Pool Liquidity</div>
                    <div className="text-xl font-bold">
                      ${formatNumber(behaviourStats.avgLiquidityUsd ?? 0, 0)}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Sample Size</div>
                    <div className="text-xl font-bold">{behaviourStats.sampleTrades}</div>
                  </div>
                </div>
              </div>
            )}

            {hasLegacyStats && advancedStats && (
              <div className="border border-border rounded-lg p-6 mb-8">
                <h2 className="text-lg font-semibold mb-4">Advanced Statistics</h2>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Profit Factor</div>
                    <div className="text-xl font-bold">
                      {advancedStats.profitFactor === Infinity
                        ? '∞'
                        : formatNumber(advancedStats.profitFactor ?? 0, 2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Max Win Streak</div>
                    <div className="text-xl font-bold">{advancedStats.maxWinStreak ?? '-'}</div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Max Loss Streak</div>
                    <div className="text-xl font-bold">{advancedStats.maxLossStreak ?? '-'}</div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Avg Win</div>
                    <div className="text-xl font-bold text-green-600">
                      {typeof advancedStats.avgWin === 'number'
                        ? `+${formatPercent((advancedStats.avgWin ?? 0) / 100)}`
                        : '-'}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Avg Loss</div>
                    <div className="text-xl font-bold text-red-600">
                      {typeof advancedStats.avgLoss === 'number'
                        ? formatPercent((advancedStats.avgLoss ?? 0) / 100)
                        : '-'}
                    </div>
                  </div>
                  {advancedStats.bestTrade && (
                    <div>
                      <div className="text-sm text-muted-foreground mb-1">Best Trade</div>
                      <div className="text-xl font-bold text-green-600">
                        +{formatPercent((advancedStats.bestTrade.pnlPercent ?? 0) / 100)}
                      </div>
                    </div>
                  )}
                  {advancedStats.worstTrade && (
                    <div>
                      <div className="text-sm text-muted-foreground mb-1">Worst Trade</div>
                      <div className="text-xl font-bold text-red-600">
                        {formatPercent((advancedStats.worstTrade.pnlPercent ?? 0) / 100)}
                      </div>
                    </div>
                  )}
                </div>

                {advancedStats.tokenStats && advancedStats.tokenStats.length > 0 && (
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
                          {advancedStats.tokenStats.slice(0, 10).map((stat: any) => (
                            <tr key={stat.tokenId} className="border-b border-border">
                              <td className="py-2">{stat.tokenId.slice(0, 8)}...</td>
                              <td className="text-right py-2">{stat.count}</td>
                              <td className="text-right py-2">{formatPercent(stat.winRate ?? 0)}</td>
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

                {advancedStats.dexStats && advancedStats.dexStats.length > 0 && (
                  <div className="mt-6">
                    <h3 className="text-md font-semibold mb-3">DEX Usage</h3>
                    <div className="flex flex-wrap gap-4">
                      {advancedStats.dexStats.map((stat: any) => (
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
            <h2 className="text-lg font-semibold mb-4">PnL Over Time</h2>
            {pnlData && pnlData.daily && pnlData.daily.length > 0 ? (
              <>
                <div className="flex gap-2 mb-4">
                  {(['7d', '30d', '90d', '1y'] as const).map((period) => (
                    <button
                      key={period}
                      onClick={() => setPnlTimeframe(period)}
                      className={`px-3 py-1 text-sm rounded ${
                        pnlTimeframe === period
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:bg-muted/80'
                      }`}
                    >
                      {period}
                    </button>
                  ))}
                </div>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={pnlData.daily}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="cumulativePnl"
                      stroke="#82ca9d"
                      strokeWidth={2}
                      name="Cumulative PnL"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </>
            ) : (
              <div className="text-center text-muted-foreground py-12">
                No PnL data available
              </div>
            )}
          </div>
        </div>
          </>
        )}
      </div>
    </div>
  );
}

