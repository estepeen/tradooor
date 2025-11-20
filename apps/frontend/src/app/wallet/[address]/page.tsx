'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { fetchSmartWallet, fetchTrades, fetchWalletPnl, fetchWalletPortfolio } from '@/lib/api';
import { formatAddress, formatPercent, formatNumber, formatDate, formatDateTimeCZ, formatHoldTime } from '@/lib/utils';
import { computePositionMetricsFromPercent } from '@/lib/positions';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import type { SmartWallet, Trade } from '@solbot/shared';

// Calculate positions from trades
function calculatePositionsFromTrades(trades: Trade[]) {
  const positionMap = new Map<string, {
    tokenId: string;
    token: any;
    totalBought: number;
    totalSold: number;
    balance: number;
    totalInvested: number;
    totalSoldValue: number;
    buyCount: number;
    sellCount: number;
    firstBuyTimestamp: Date | null;
    lastSellTimestamp: Date | null;
    lastBuyPrice: number;
    lastSellPrice: number;
  }>();

  // Sort trades chronologically
  const sortedTrades = [...trades].sort((a, b) => 
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  for (const trade of sortedTrades) {
    const tokenId = trade.tokenId;
    const token = trade.token || null;
    const amount = Number(trade.amountToken);
    const valueUsd = Number(trade.valueUsd || 0);
    const price = Number(trade.priceBasePerToken);
    const tradeTimestamp = new Date(trade.timestamp);

    if (!positionMap.has(tokenId)) {
      positionMap.set(tokenId, {
        tokenId,
        token,
        totalBought: 0,
        totalSold: 0,
        balance: 0,
        totalInvested: 0,
        totalSoldValue: 0,
        buyCount: 0,
        sellCount: 0,
        firstBuyTimestamp: null,
        lastSellTimestamp: null,
        lastBuyPrice: 0,
        lastSellPrice: 0,
      });
    }

    const position = positionMap.get(tokenId)!;

    if (trade.side === 'buy') {
      position.totalBought += amount;
      position.balance += amount;
      position.totalInvested += valueUsd || (amount * price);
      position.buyCount++;
      position.lastBuyPrice = price;
      if (!position.firstBuyTimestamp || tradeTimestamp < position.firstBuyTimestamp) {
        position.firstBuyTimestamp = tradeTimestamp;
      }
    } else if (trade.side === 'sell') {
      position.totalSold += amount;
      position.balance = Math.max(0, position.balance - amount);
      position.sellCount++;
      position.lastSellPrice = price;
      position.totalSoldValue += valueUsd || (amount * price);
      if (!position.lastSellTimestamp || tradeTimestamp > position.lastSellTimestamp) {
        position.lastSellTimestamp = tradeTimestamp;
      }
    }
  }

  // Separate open and closed positions
  const openPositions: any[] = [];
  const closedPositions: any[] = [];

  for (const position of positionMap.values()) {
    const averageBuyPrice = position.totalBought > 0 
      ? position.totalInvested / position.totalBought 
      : 0;

    // Use current price from last trade or average buy price
    const currentPrice = position.lastBuyPrice || averageBuyPrice;
    const currentValue = position.balance > 0
      ? position.balance * currentPrice
      : 0;

    const pnl = currentValue - (position.balance * averageBuyPrice);
    const pnlPercent = (position.balance * averageBuyPrice) > 0
      ? (pnl / (position.balance * averageBuyPrice)) * 100
      : 0;

    // Calculate closed position PnL
    const closedPnl = position.balance <= 0 && position.totalSoldValue > 0
      ? position.totalSoldValue - position.totalInvested
      : null;
    const closedPnlPercent = closedPnl !== null && position.totalInvested > 0
      ? (closedPnl / position.totalInvested) * 100
      : null;

    // Calculate hold time for closed positions
    const holdTimeMinutes = position.firstBuyTimestamp && position.lastSellTimestamp && position.balance <= 0
      ? Math.round((position.lastSellTimestamp.getTime() - position.firstBuyTimestamp.getTime()) / (1000 * 60))
      : null;

    const positionData = {
      ...position,
      averageBuyPrice,
      currentPrice,
      currentValue,
      pnl,
      pnlPercent,
      closedPnl,
      closedPnlPercent,
      holdTimeMinutes,
      firstBuyTimestamp: position.firstBuyTimestamp?.toISOString() || null,
      lastSellTimestamp: position.lastSellTimestamp?.toISOString() || null,
    };

    if (position.balance > 0 && currentValue > 1) {
      // Open position with value > $1
      openPositions.push(positionData);
    } else if (position.balance <= 0 && position.sellCount > 0) {
      // Closed position - DŮLEŽITÉ: Zobrazujeme pouze pozice s platným HOLD time (známe BUY i SELL)
      // Musí mít alespoň jeden BUY a jeden SELL, a platný holdTimeMinutes (povolujeme i 0)
      if (position.buyCount > 0 && position.sellCount > 0 && holdTimeMinutes !== null && holdTimeMinutes >= 0) {
      closedPositions.push(positionData);
      }
    }
  }

  // Sort open positions by value (descending)
  openPositions.sort((a, b) => b.currentValue - a.currentValue);

  // Sort closed positions by last sell timestamp (most recent first)
  closedPositions.sort((a, b) => {
    const aTime = a.lastSellTimestamp ? new Date(a.lastSellTimestamp).getTime() : 0;
    const bTime = b.lastSellTimestamp ? new Date(b.lastSellTimestamp).getTime() : 0;
    return bTime - aTime;
  });

  return { openPositions, closedPositions };
}

export default function WalletDetailPage() {
  const params = useParams();
  const walletAddress = params.address as string; // Now using address instead of id
  
  const [wallet, setWallet] = useState<any>(null);
  const [trades, setTrades] = useState<{ trades: Trade[]; total: number } | null>(null);
  const [pnlData, setPnlData] = useState<any>(null);
  const [portfolio, setPortfolio] = useState<any>({ openPositions: [], closedPositions: [] });
  const [loading, setLoading] = useState(true);
  const [showAllOpenPositions, setShowAllOpenPositions] = useState(false);
  const [showAllClosedPositions, setShowAllClosedPositions] = useState(false);
  const [tokenFilter, setTokenFilter] = useState<string>('');
  const [timeframeFilter, setTimeframeFilter] = useState<string>('all');
  const [pnlTimeframe, setPnlTimeframe] = useState<'7d' | '30d' | '90d' | '1y'>('30d');
  const [activeTab, setActiveTab] = useState<'basic' | 'advanced'>('basic');
  const [portfolioLastUpdated, setPortfolioLastUpdated] = useState<Date | null>(null);
  const [portfolioRefreshing, setPortfolioRefreshing] = useState(false);
  const [countdown, setCountdown] = useState<number>(0);
  const [recentTradesPage, setRecentTradesPage] = useState<number>(1);
  const RECENT_TRADES_PER_PAGE = 50;

  useEffect(() => {
    if (walletAddress) {
      loadData();
    }
  }, [walletAddress, tokenFilter, timeframeFilter]);

  // Reset page when filter changes
  useEffect(() => {
    setRecentTradesPage(1);
  }, [tokenFilter, timeframeFilter]);

  // Automatic portfolio update every 1 minute (to catch new closed positions from recent trades)
  useEffect(() => {
    if (!walletAddress) return;
    
    const refreshPortfolio = async (forceRefresh: boolean = false) => {
      try {
        const walletData = await fetchSmartWallet(walletAddress);
        const actualWalletId = walletData?.id || walletAddress;
        // Force refresh to get latest closed positions from new trades
        const portfolioData = await fetchWalletPortfolio(actualWalletId, forceRefresh);
        setPortfolio(portfolioData);
        if (portfolioData.lastUpdated) {
          setPortfolioLastUpdated(new Date(portfolioData.lastUpdated));
        }
      } catch (error) {
        console.error('Error auto-refreshing portfolio:', error);
      }
    };

    // First load (force refresh to get latest data)
    refreshPortfolio(true);

    // Set interval for automatic update every 1 minute (to catch new closed positions)
    const interval = setInterval(() => refreshPortfolio(true), 60 * 1000); // 1 minute

    return () => clearInterval(interval);
  }, [walletAddress]);

  // Countdown timer to show until next update
  useEffect(() => {
    if (!portfolioLastUpdated) return;

    const updateCountdown = () => {
      const now = Date.now();
      const lastUpdate = portfolioLastUpdated.getTime();
      const nextUpdate = lastUpdate + 60 * 1000; // 1 minute
      const remaining = Math.max(0, Math.floor((nextUpdate - now) / 1000));
      setCountdown(remaining);
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);

    return () => clearInterval(interval);
  }, [portfolioLastUpdated]);

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
      // Use walletAddress instead of walletId (API supports both)
      const walletData = await fetchSmartWallet(walletAddress); // API now supports address
      
      if (!walletData) {
        setWallet(null);
        return;
      }
      
      const actualWalletId = walletData.id || walletAddress;
      
      const [tradesData, pnl, portfolioData] = await Promise.all([
        fetchTrades(actualWalletId, { 
          page: 1, 
          pageSize: 10000, // Load all trades for position calculation
          tokenId: tokenFilter || undefined,
          fromDate,
        }).catch((err) => {
          console.error('Error fetching trades:', err);
          return { trades: [], total: 0 };
        }),
        fetchWalletPnl(walletAddress).catch(() => null), // PnL data is optional
        fetchWalletPortfolio(actualWalletId, true).catch(() => null), // Force refresh portfolio to get latest closed positions
      ]);
      
      setWallet(walletData);
      setTrades(tradesData);
      setPnlData(pnl);
      if (portfolioData) {
        setPortfolio(portfolioData);
        if (portfolioData.lastUpdated) {
          setPortfolioLastUpdated(new Date(portfolioData.lastUpdated));
        }
      }
    } catch (error: any) {
      console.error('Error loading wallet data:', error);
      // Pokud je to 404, nastav wallet na null, aby se zobrazilo "Wallet not found"
      if (error?.message?.includes('404') || error?.message?.includes('not found')) {
        setWallet(null);
      }
    } finally {
      setLoading(false);
    }
  }

  const allTrades = trades?.trades || [];
  // Portfolio se načítá z API (s aktuálními cenami z Birdeye)
  // Pro closed positions použijeme výpočet z trades, pokud portfolio z API nemá closed positions
  const calculatedPortfolio = calculatePositionsFromTrades(allTrades);
  // Použij portfolio z API pro open positions, ale použij calculatedPortfolio pro closed positions, pokud API nemá closed positions
  // DŮLEŽITÉ: Použijeme calculatedPortfolio pouze pokud API nemá closed positions, a pak je ještě filtrujeme
  const apiClosedPositions = portfolio?.closedPositions || [];
  
  // VŽDY použij closed positions z API (pokud existují), protože backend už je správně filtruje
  // calculatedPortfolio použijeme pouze jako poslední fallback, pokud API vůbec nevrátilo closed positions
  const calculatedClosedPositions = calculatedPortfolio.closedPositions || [];
  
  // Filtruj calculated closed positions - pouze ty s platným HOLD time (povolujeme i 0)
  const filteredCalculatedClosed = calculatedClosedPositions.filter((p: any) => {
    return p.holdTimeMinutes !== null && p.holdTimeMinutes !== undefined && p.holdTimeMinutes >= 0 &&
           p.buyCount > 0 && p.sellCount > 0;
  });
  
  // DŮLEŽITÉ: Použij API closed positions, i když je pole prázdné (znamená to, že backend správně filtroval)
  // calculatedPortfolio použijeme pouze pokud portfolio z API vůbec neexistuje
  const finalPortfolio = {
    openPositions: portfolio?.openPositions || [],
    closedPositions: portfolio && portfolio.closedPositions !== undefined
      ? apiClosedPositions  // Použij API data (i když je pole prázdné)
      : filteredCalculatedClosed,  // Fallback pouze pokud portfolio z API neexistuje
  };
  const positionMetrics = computePositionMetricsFromPercent(
    allTrades.map((trade) => ({
      id: trade.id,
      tokenId: trade.tokenId,
      positionChangePercent:
        trade.positionChangePercent !== null && trade.positionChangePercent !== undefined
          ? Number(trade.positionChangePercent)
          : null,
      timestamp: trade.timestamp,
    }))
  );

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
            <a
              href={`https://solscan.io/account/${wallet.address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground"
              title="View on Solscan"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M6 3.5H3.5C2.67157 3.5 2 4.17157 2 5V12.5C2 13.3284 2.67157 14 3.5 14H11C11.8284 14 12.5 13.3284 12.5 12.5V10M9.5 2.5H13.5M13.5 2.5V6.5M13.5 2.5L6.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </a>
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

        {/* Open & Closed Positions */}
        <div className="mb-10">
          <h2 style={{ fontSize: '2rem', marginBottom: '1rem' }} className="font-semibold">Positions Overview</h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Open Positions */}
              <div className="overflow-hidden">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-xl font-semibold">Open Positions</h3>
                  <button
                    onClick={async () => {
                      if (!walletAddress || portfolioRefreshing) return;
                      setPortfolioRefreshing(true);
                      try {
                        const walletData = await fetchSmartWallet(walletAddress);
                        const actualWalletId = walletData?.id || walletAddress;
                        const portfolioData = await fetchWalletPortfolio(actualWalletId, true); // forceRefresh=true
                        setPortfolio(portfolioData);
                        if (portfolioData.lastUpdated) {
                          setPortfolioLastUpdated(new Date(portfolioData.lastUpdated));
                        }
                      } catch (error) {
                        console.error('Error refreshing portfolio:', error);
                      } finally {
                        setPortfolioRefreshing(false);
                      }
                    }}
                    disabled={portfolioRefreshing}
                    className="px-3 py-1.5 text-sm bg-muted text-foreground rounded-md hover:bg-muted/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {portfolioRefreshing ? 'Updating...' : 'Update'}
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-muted/30">
                      <tr>
                        <th className="px-4 py-3 text-left text-sm font-medium">TOKEN</th>
                        <th className="px-4 py-3 text-right text-sm font-medium">BALANCE</th>
                        <th className="px-4 py-3 text-right text-sm font-medium">VALUE</th>
                        <th className="px-4 py-3 text-right text-sm font-medium">Live PnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const openPositions = finalPortfolio.openPositions || [];
                        if (openPositions.length === 0) {
                          return (
                            <tr className="border-t border-border">
                              <td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">
                                No open positions
                              </td>
                            </tr>
                          );
                        }

                        const items = openPositions.slice(0, showAllOpenPositions ? openPositions.length : 10);
                        return items.map((position: any) => {
                          const token = position.token;
                          const balance = position.balance || 0;
                          const value = position.currentValue || (balance * (position.averageBuyPrice || 0));
                          // Use livePnl from API (if exists), otherwise fallback to pnl
                          const pnl = position.livePnl !== undefined ? position.livePnl : (position.pnl || 0);
                          const pnlPercent = position.livePnlPercent !== undefined ? position.livePnlPercent : (position.pnlPercent || 0);

                          return (
                            <tr key={position.tokenId} className="border-t border-border hover:bg-muted/50">
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
                                      : `${token.mintAddress.slice(0, 6)}...${token.mintAddress.slice(-6)}`}
                                  </a>
                                ) : (
                                  <span className="text-muted-foreground">-</span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-right text-sm font-mono">
                                {formatNumber(balance, 2)}
                              </td>
                              <td className="px-4 py-3 text-right text-sm font-mono">
                                {value > 0 ? `$${formatNumber(value, 2)}` : '-'}
                              </td>
                              <td className={`px-4 py-3 text-right text-sm font-mono ${
                                pnl >= 0 ? 'text-green-400' : 'text-red-400'
                              }`}>
                                {pnl !== 0 ? (
                                  <>
                                    ${formatNumber(Math.abs(pnl), 2)} ({pnlPercent >= 0 ? '+' : ''}{formatPercent(pnlPercent / 100)})
                                  </>
                                ) : '-'}
                              </td>
                            </tr>
                          );
                        });
                      })()}
                    </tbody>
                  </table>
                </div>
                {finalPortfolio.openPositions && finalPortfolio.openPositions.length > 10 && (
                  <div className="mt-4 text-center">
                    <button
                      onClick={() => setShowAllOpenPositions(!showAllOpenPositions)}
                      className="text-sm text-muted-foreground hover:text-foreground"
                    >
                      {showAllOpenPositions ? 'Show Less' : `Show More (${finalPortfolio.openPositions.length - 10} more)`}
                    </button>
                  </div>
                )}
                {/* Last update info */}
                {portfolioLastUpdated && (
                  <div className="mt-3 text-xs text-muted-foreground text-center">
                    Last updated: {portfolioLastUpdated.toLocaleTimeString('en-US')}
                    {countdown > 0 && (
                      <span className="ml-2">
                        • Next update in: {Math.floor(countdown / 60)}:{(countdown % 60).toString().padStart(2, '0')}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Closed Positions */}
              <div className="overflow-hidden">
                <h3 className="text-xl font-semibold mb-4">Closed Positions</h3>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-muted/30">
                      <tr>
                        <th className="px-4 py-3 text-left text-sm font-medium">DATE</th>
                        <th className="px-4 py-3 text-left text-sm font-medium">TOKEN</th>
                        <th className="px-4 py-3 text-right text-sm font-medium">PnL</th>
                        <th className="px-4 py-3 text-right text-sm font-medium">HOLD TIME</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        // Filtruj pouze pozice s platným HOLD time (známe BUY i SELL)
                        // Povolujeme i holdTimeMinutes = 0 (stejný timestamp BUY/SELL)
                        const closedPositions = (finalPortfolio.closedPositions || [])
                          .filter((p: any) => {
                            // Musí mít platný holdTimeMinutes (známe BUY i SELL) - povolujeme i 0
                            const hasValidHoldTime = p.holdTimeMinutes !== null && p.holdTimeMinutes !== undefined && p.holdTimeMinutes >= 0;
                            // Musí mít také buyCount a sellCount > 0
                            const hasBuyAndSell = p.buyCount > 0 && p.sellCount > 0;
                            if (!hasValidHoldTime || !hasBuyAndSell) {
                              console.warn('Filtering out closed position:', p.token?.symbol, 'holdTime:', p.holdTimeMinutes, 'buyCount:', p.buyCount, 'sellCount:', p.sellCount);
                            }
                            return hasValidHoldTime && hasBuyAndSell;
                          });
                        
                        if (closedPositions.length === 0) {
                          return (
                            <tr className="border-t border-border">
                              <td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">
                                No closed positions
                              </td>
                            </tr>
                          );
                        }

                        const items = closedPositions.slice(0, showAllClosedPositions ? closedPositions.length : 10);
                        return items.map((position: any) => {
                          const token = position.token;
                          const closedPnl = position.closedPnl ?? 0;
                          const closedPnlPercent = position.closedPnlPercent ?? 0;
                          const holdTimeMinutes = position.holdTimeMinutes ?? null;
                          const sellDate = position.lastSellTimestamp
                            ? formatDate(new Date(position.lastSellTimestamp))
                            : '-';

                          return (
                            <tr key={position.tokenId} className="border-t border-border hover:bg-muted/50">
                              <td className="px-4 py-3 text-sm text-muted-foreground">
                                {sellDate}
                              </td>
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
                                      : `${token.mintAddress.slice(0, 6)}...${token.mintAddress.slice(-6)}`}
                                  </a>
                                ) : (
                                  <span className="text-muted-foreground">-</span>
                                )}
                              </td>
                              <td className={`px-4 py-3 text-right text-sm font-mono ${
                                closedPnl >= 0 ? 'text-green-400' : 'text-red-400'
                              }`}>
                                {closedPnl !== 0 ? (
                                  <>
                                    ${formatNumber(Math.abs(closedPnl), 2)} ({closedPnlPercent >= 0 ? '+' : ''}{formatPercent((closedPnlPercent || 0) / 100)})
                                  </>
                                ) : '-'}
                              </td>
                              <td className="px-4 py-3 text-right text-sm font-mono">
                                {holdTimeMinutes !== null ? formatHoldTime(holdTimeMinutes) : '-'}
                              </td>
                            </tr>
                          );
                        });
                      })()}
                    </tbody>
                  </table>
                </div>
                {finalPortfolio.closedPositions && finalPortfolio.closedPositions.length > 10 && (
                  <div className="mt-4 text-center">
                    <button
                      onClick={() => setShowAllClosedPositions(!showAllClosedPositions)}
                      className="text-sm text-muted-foreground hover:text-foreground"
                    >
                      {showAllClosedPositions ? 'Show Less' : `Show More (${finalPortfolio.closedPositions.length - 10} more)`}
                    </button>
                  </div>
                )}
              </div>
            </div>
        </div>
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
                      <th className="px-4 py-3 text-center text-sm font-medium">POSITION</th>
                      <th className="px-4 py-3 text-right text-sm font-medium">PRICE</th>
                      <th className="px-4 py-3 text-right text-sm font-medium">AMOUNT</th>
                      <th className="px-4 py-3 text-right text-sm font-medium">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      // Filtruj trades podle tokenFilter a timeframeFilter
                      let filteredTrades = [...allTrades];
                      
                      // Filtruj podle tokenu
                      if (tokenFilter) {
                        const filterLower = tokenFilter.toLowerCase();
                        filteredTrades = filteredTrades.filter(trade => {
                          const symbol = trade.token?.symbol?.toLowerCase() || '';
                          const name = trade.token?.name?.toLowerCase() || '';
                          const mintAddress = trade.token?.mintAddress?.toLowerCase() || '';
                          return symbol.includes(filterLower) || name.includes(filterLower) || mintAddress.includes(filterLower);
                        });
                      }
                      
                      // Filtruj podle časového rámce
                      if (timeframeFilter !== 'all') {
                        const now = new Date();
                        let fromDate: Date;
                        switch (timeframeFilter) {
                          case '24h':
                            fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                            break;
                          case '7d':
                            fromDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                            break;
                          case '30d':
                            fromDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                            break;
                          default:
                            fromDate = new Date(0);
                        }
                        filteredTrades = filteredTrades.filter(trade => 
                          new Date(trade.timestamp) >= fromDate
                        );
                      }
                      
                      // Seřaď podle data (nejnovější první)
                      const allTradesSorted = filteredTrades.sort((a, b) => 
                        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
                      );
                      
                      // Stránkování - zobrazujeme po 50 záznamech
                      const totalPages = Math.ceil(allTradesSorted.length / RECENT_TRADES_PER_PAGE);
                      const startIndex = (recentTradesPage - 1) * RECENT_TRADES_PER_PAGE;
                      const endIndex = startIndex + RECENT_TRADES_PER_PAGE;
                      const recentTrades = allTradesSorted.slice(startIndex, endIndex);
                      
                      if (recentTrades.length === 0) {
                        return (
                          <tr className="border-t border-border">
                            <td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">
                              No trades found
                            </td>
                          </tr>
                        );
                      }
                      
                      return (
                        <>
                          {recentTrades.map((trade) => {
                        const tradeDate = new Date(trade.timestamp);
                        // Použij side z backendu (může být 'buy', 'sell', 'add', 'remove')
                        let tradeType: 'BUY' | 'ADD' | 'SELL' | 'REM' = 'BUY';
                        if (trade.side === 'buy') {
                          tradeType = 'BUY';
                        } else if (trade.side === 'add') {
                          tradeType = 'ADD';
                        } else if (trade.side === 'sell') {
                          tradeType = 'SELL';
                        } else if (trade.side === 'remove') {
                          tradeType = 'REM';
                        }
                        
                        const metrics = positionMetrics[trade.id];
                        
                        const positionDisplay = metrics
                          ? `${metrics.positionXAfter.toFixed(2)}x (${metrics.deltaX >= 0 ? '+' : ''}${metrics.deltaX.toFixed(2)}x)`
                          : '-';
                        
                          const amountToken = Number(trade.amountToken);
                          const amountBase = Number(trade.amountBase);
                          const priceBasePerToken = Number(trade.priceBasePerToken);
                          const baseToken = (trade as any).baseToken || (trade as any).meta?.baseToken || 'SOL'; // SOL, USDC, USDT
                          
                          // Use priceUsd from meta (calculated in backend: priceBasePerToken * historical SOL price from Binance)
                          // If not available, use priceBasePerToken as fallback
                          const priceUsd = (trade as any).priceUsd || (trade as any).meta?.priceUsd || null;
                          const entryPrice = priceBasePerToken;
                          const entryCost = (trade as any).entryCost || (trade.side === 'buy' || trade.side === 'add' ? amountBase : null);
                          const proceedsBase = (trade as any).proceedsBase || (trade.side === 'sell' || trade.side === 'remove' ? amountBase : null);
                          const amountDisplay = amountToken && amountToken > 0
                            ? `${formatNumber(amountToken, 2)} $${trade.token?.symbol || trade.token?.name || ''}`.trim()
                            : `${formatNumber(Number(trade.amountBase), 2)} SOL`;

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
                              <span className={`px-2 py-1 rounded text-xs font-medium ${
                                tradeType === 'BUY'
                                  ? 'bg-green-500/20 text-green-400'
                                  : tradeType === 'SELL'
                                  ? 'bg-red-500/20 text-red-400'
                                  : tradeType === 'ADD'
                                  ? 'bg-transparent text-[rgb(75,222,127)] border border-[#22c55e]'
                                  : 'bg-transparent text-[rgb(248,113,112)] border border-[#ef4444]'
                              }`}>
                                {tradeType}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-sm">
                              {trade.token?.mintAddress ? (
                                <a
                                  href={`https://birdeye.so/solana/token/${trade.token.mintAddress}`}
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
                            <td className="px-4 py-3 text-center text-sm font-mono">
                              {metrics ? (
                                <span className={
                                  metrics.deltaX > 0
                                    ? 'text-green-400'
                                    : metrics.deltaX < 0
                                    ? 'text-red-400'
                                    : 'text-muted-foreground'
                                }>
                                  {positionDisplay}
                                </span>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </td>
                            <td className={`px-4 py-3 text-right text-sm font-mono ${
                              tradeType === 'BUY' || tradeType === 'ADD' ? 'text-green-400' : 'text-red-400'
                            }`}>
                            {trade.token?.mintAddress ? (
                              <a
                                  href={`https://birdeye.so/solana/token/${trade.token.mintAddress}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                  className="hover:underline cursor-pointer"
                              >
                                  {priceUsd !== null && priceUsd !== undefined && priceUsd > 0
                                    ? `$${formatNumber(priceUsd, 6)}`
                                    : entryPrice > 0
                                    ? `${formatNumber(entryPrice, 6)} ${baseToken}`
                                    : '-'}
                              </a>
                            ) : (
                                priceUsd !== null && priceUsd !== undefined && priceUsd > 0
                                  ? `$${formatNumber(priceUsd, 6)}`
                                  : entryPrice > 0
                                  ? `${formatNumber(entryPrice, 6)} ${baseToken}`
                                  : '-'
                            )}
                          </td>
                            <td className={`px-4 py-3 text-right text-sm font-mono ${
                              tradeType === 'BUY' || tradeType === 'ADD' ? 'text-green-400' : 'text-red-400'
                            }`}>
                              {trade.token?.mintAddress ? (
                                <a
                                  href={`https://birdeye.so/solana/token/${trade.token.mintAddress}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="hover:underline cursor-pointer"
                                >
                                  {amountDisplay}
                                </a>
                              ) : (
                                amountDisplay
                              )}
                            </td>
                            <td className={`px-4 py-3 text-right text-sm font-mono ${
                              tradeType === 'BUY' || tradeType === 'ADD' ? 'text-green-400' : 'text-red-400'
                            }`}>
                              {amountBase > 0 ? `${formatNumber(amountBase, 6)} ${baseToken}` : '-'}
                            </td>
                        </tr>
                      );
                          })}
                        </>
                      );
                    })()}
                  </tbody>
                </table>
              </div>
              
              {/* Stránkování */}
              {(() => {
                // Použij stejné filtrování jako v tabulce
                let filteredTrades = [...allTrades];
                
                // Filtruj podle tokenu
                if (tokenFilter) {
                  const filterLower = tokenFilter.toLowerCase();
                  filteredTrades = filteredTrades.filter(trade => {
                    const symbol = trade.token?.symbol?.toLowerCase() || '';
                    const name = trade.token?.name?.toLowerCase() || '';
                    const mintAddress = trade.token?.mintAddress?.toLowerCase() || '';
                    return symbol.includes(filterLower) || name.includes(filterLower) || mintAddress.includes(filterLower);
                  });
                }
                
                // Filtruj podle časového rámce
                if (timeframeFilter !== 'all') {
                  const now = new Date();
                  let fromDate: Date;
                  switch (timeframeFilter) {
                    case '24h':
                      fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                      break;
                    case '7d':
                      fromDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                      break;
                    case '30d':
                      fromDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                      break;
                    default:
                      fromDate = new Date(0);
                  }
                  filteredTrades = filteredTrades.filter(trade => 
                    new Date(trade.timestamp) >= fromDate
                  );
                }
                
                const allTradesSorted = filteredTrades.sort((a, b) => 
                  new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
                );
                const totalPages = Math.ceil(allTradesSorted.length / RECENT_TRADES_PER_PAGE);
                
                if (totalPages <= 1) {
                  return null;
                }
                
                // Zobrazíme maximálně 10 čísel stránek
                const maxVisiblePages = 10;
                let startPage = Math.max(1, recentTradesPage - Math.floor(maxVisiblePages / 2));
                let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
                
                // Upravíme startPage, pokud jsme na konci
                if (endPage - startPage < maxVisiblePages - 1) {
                  startPage = Math.max(1, endPage - maxVisiblePages + 1);
                }
                
                const pageNumbers = [];
                for (let i = startPage; i <= endPage; i++) {
                  pageNumbers.push(i);
                }
                
                return (
                  <div className="mt-4 flex justify-center items-center gap-2 flex-wrap">
                    <button
                      onClick={() => setRecentTradesPage(1)}
                      disabled={recentTradesPage === 1}
                      className="px-3 py-1.5 text-sm border border-border rounded-md bg-background hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      «
                    </button>
                    <button
                      onClick={() => setRecentTradesPage(Math.max(1, recentTradesPage - 1))}
                      disabled={recentTradesPage === 1}
                      className="px-3 py-1.5 text-sm border border-border rounded-md bg-background hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      ‹
                    </button>
                    
                    {startPage > 1 && (
                      <>
                        <button
                          onClick={() => setRecentTradesPage(1)}
                          className="px-3 py-1.5 text-sm border border-border rounded-md bg-background hover:bg-muted"
                        >
                          1
                        </button>
                        {startPage > 2 && <span className="px-2 text-muted-foreground">...</span>}
                      </>
                    )}
                    
                    {pageNumbers.map((pageNum) => (
                      <button
                        key={pageNum}
                        onClick={() => setRecentTradesPage(pageNum)}
                        className={`px-3 py-1.5 text-sm border rounded-md ${
                          recentTradesPage === pageNum
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-background border-border hover:bg-muted'
                        }`}
                      >
                        {pageNum}
                      </button>
                    ))}
                    
                    {endPage < totalPages && (
                      <>
                        {endPage < totalPages - 1 && <span className="px-2 text-muted-foreground">...</span>}
                        <button
                          onClick={() => setRecentTradesPage(totalPages)}
                          className="px-3 py-1.5 text-sm border border-border rounded-md bg-background hover:bg-muted"
                        >
                          {totalPages}
                        </button>
                      </>
                    )}
                    
                    <button
                      onClick={() => setRecentTradesPage(Math.min(totalPages, recentTradesPage + 1))}
                      disabled={recentTradesPage === totalPages}
                      className="px-3 py-1.5 text-sm border border-border rounded-md bg-background hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      ›
                    </button>
                    <button
                      onClick={() => setRecentTradesPage(totalPages)}
                      disabled={recentTradesPage === totalPages}
                      className="px-3 py-1.5 text-sm border border-border rounded-md bg-background hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      »
                    </button>
                    
                    <span className="ml-4 text-sm text-muted-foreground">
                      Stránka {recentTradesPage} z {totalPages} ({allTradesSorted.length} celkem)
                    </span>
                  </div>
                );
              })()}
              
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

