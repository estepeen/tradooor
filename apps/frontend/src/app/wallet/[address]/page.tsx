'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { fetchSmartWallet, fetchTrades, fetchWalletPnl, fetchWalletPortfolio, deletePosition } from '@/lib/api';
import { formatAddress, formatPercent, formatNumber, formatDate, formatDateTimeCZ, formatHoldTime } from '@/lib/utils';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import type { SmartWallet, Trade } from '@solbot/shared';
import { Spinner } from '@/components/Spinner';

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
  conviction:
    'Conviction: alespoň 10 closed trades, win rate ≥ 60 %, frekvence low/medium a průměrná velikost pozice ≳ 200 USD.',
};

const getTagTooltip = (tag: string) =>
  TAG_TOOLTIPS[tag.toLowerCase()] || 'User-defined tag pro kategorizaci tradera.';

export default function WalletDetailPage() {
  const params = useParams();
  const walletAddress = params.address as string; // Now using address instead of id
  
  const [wallet, setWallet] = useState<any>(null);
  const [trades, setTrades] = useState<{ trades: Trade[]; total: number } | null>(null);
  const [pnlData, setPnlData] = useState<any>(null);
  const [portfolio, setPortfolio] = useState<any>({ closedPositions: [] });
  const [loading, setLoading] = useState(true);
  const [showAllClosedPositions, setShowAllClosedPositions] = useState(false);
  const [tokenFilter, setTokenFilter] = useState<string>('');
  const [timeframeFilter, setTimeframeFilter] = useState<string>('all');
  const [pnlTimeframe, setPnlTimeframe] = useState<'7d' | '30d' | '90d' | '1y'>('30d');
  const [activeTab, setActiveTab] = useState<'basic' | 'advanced'>('basic');
  const [portfolioLastUpdated, setPortfolioLastUpdated] = useState<Date | null>(null);
  const [portfolioRefreshing, setPortfolioRefreshing] = useState(false);
  const [countdown, setCountdown] = useState<number>(0);
  const [displayedTradesCount, setDisplayedTradesCount] = useState<number>(50); // Kolik trades se aktuálně zobrazuje
  const RECENT_TRADES_PER_PAGE = 50;
  const [tradesLoading, setTradesLoading] = useState<boolean>(true);
  const [loadingMoreTrades, setLoadingMoreTrades] = useState<boolean>(false);
  const [deletingPosition, setDeletingPosition] = useState<string | null>(null);
  const [pnlLoading, setPnlLoading] = useState<boolean>(true);
  const [portfolioLoading, setPortfolioLoading] = useState<boolean>(true);

  const loadData = useCallback(async () => {
    if (!walletAddress) return;
    setLoading(true);
    try {
      // OPTIMALIZACE: Načti pouze kritická data (wallet info) synchronně pro rychlý první render
      const walletData = await fetchSmartWallet(walletAddress);
      
      if (!walletData) {
        setWallet(null);
        setLoading(false);
        return;
      }
      
      setWallet(walletData);
      setLoading(false); // Zobraz profil okamžitě po načtení wallet info (do 1-2s)
      
      // Načti další data na pozadí (lazy loading) - neblokují první render
      const actualWalletId = walletData.id || walletAddress;
      
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
      
      // OPTIMALIZACE: Načti další části paralelně a nastav sekční loading stavy
      setTradesLoading(true);
      setPnlLoading(true);
      setPortfolioLoading(true);

      // Trades - načti první 50 trades
      fetchTrades(actualWalletId, { 
        page: 1, 
        pageSize: 50, // Pouze první stránka pro rychlý render
        tokenId: tokenFilter || undefined,
        fromDate,
      })
        .then((data) => {
          console.log('[Load Trades] API Response:', {
            tradesCount: data.trades?.length || 0,
            total: data.total || 0,
            page: data.page || 1,
            pageSize: data.pageSize || 50,
          });
          setTrades(data);
          // Reset displayed count when loading new data
          setDisplayedTradesCount(50);
        })
        .catch((err) => {
          console.error('Error fetching trades:', err);
          setTrades({ trades: [], total: 0 });
          setDisplayedTradesCount(50);
        })
        .finally(() => {
          setTradesLoading(false);
        });

      // PnL / metrics
      fetchWalletPnl(actualWalletId)
        .then((data) => {
          setPnlData(data);
        })
        .catch(() => {
          setPnlData(null);
        })
        .finally(() => {
          setPnlLoading(false);
        });

      // Portfolio (closed positions, PnL)
      fetchWalletPortfolio(actualWalletId, false)
        .then((data) => {
          if (data) {
            setPortfolio(data);
            if (data.lastUpdated) {
              setPortfolioLastUpdated(new Date(data.lastUpdated));
            }
          } else {
            setPortfolio({ closedPositions: [] });
          }
        })
        .catch((err) => {
          console.error('Error fetching portfolio:', err);
          setPortfolio({ closedPositions: [] });
        })
        .finally(() => {
          setPortfolioLoading(false);
        });
    } catch (error: any) {
      console.error('Error loading wallet data:', error);
      // Pokud je to 404, nastav wallet na null, aby se zobrazilo "Wallet not found"
      if (error?.message?.includes('404') || error?.message?.includes('not found')) {
        setWallet(null);
      }
    } finally {
      setLoading(false);
    }
  }, [walletAddress, timeframeFilter, tokenFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Reset displayed trades count when filter changes
  useEffect(() => {
    setDisplayedTradesCount(50);
  }, [tokenFilter, timeframeFilter]);

  // OPTIMALIZACE: Portfolio se načte pouze jednou při načtení stránky
  // Worker/cron aktualizuje data na pozadí, takže není potřeba force refresh
  // Automatický refresh pouze pokud uživatel explicitně klikne na tlačítko

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


  async function loadMoreTrades() {
    if (!wallet?.id || !trades || loadingMoreTrades) return;
    
    // Vypočítej další stránku na základě počtu již načtených trades
    const currentPage = Math.ceil(trades.trades.length / RECENT_TRADES_PER_PAGE);
    const nextPage = currentPage + 1;
    
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
    
    setLoadingMoreTrades(true);
    try {
      console.log(`[Load More Trades] Loading page ${nextPage} from API...`);
      const data = await fetchTrades(wallet.id, {
        page: nextPage,
        pageSize: RECENT_TRADES_PER_PAGE,
        tokenId: tokenFilter || undefined,
        fromDate,
      });
      
      console.log(`[Load More Trades] Received ${data.trades?.length || 0} new trades from API`);
      
      // Přidej nové trades k existujícím (z databáze)
      setTrades({
        trades: [...trades.trades, ...data.trades],
        total: data.total, // Celkový počet zůstává stejný z API
      });
      
      // Zvětši počet zobrazených trades
      setDisplayedTradesCount(prev => {
        const newCount = prev + RECENT_TRADES_PER_PAGE;
        console.log(`[Load More Trades] Displayed count: ${prev} -> ${newCount}`);
        return newCount;
      });
    } catch (err) {
      console.error('Error loading more trades:', err);
    } finally {
      setLoadingMoreTrades(false);
    }
  }


  const allTrades = trades?.trades || [];
  
  const finalPortfolio = {
    closedPositions: portfolio?.closedPositions || [],
  };
  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-8">
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
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8">
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
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <h1 className="mb-0">
              {wallet.label || formatAddress(wallet.address)}
            </h1>
            {wallet.tags && wallet.tags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {wallet.tags.map((tag: string) => (
                  <span
                    key={tag}
                    className="px-2 py-1 bg-secondary text-secondary-foreground rounded text-xs"
                    title={getTagTooltip(tag)}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
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

        {/* PnL Periods Overview - Calculated from Closed Positions */}
        {(() => {
          // Calculate PnL from closed positions for each period
          const calculatePnLForPeriod = (days: number) => {
            const now = new Date();
            const fromDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
            
            // Filter closed positions by lastSellTimestamp within the period
            const closedPositions = (finalPortfolio.closedPositions || [])
              .filter((p: any) => {
                // Must have valid holdTimeMinutes and buyCount/sellCount
                const hasValidHoldTime = p.holdTimeMinutes !== null && p.holdTimeMinutes !== undefined && p.holdTimeMinutes >= 0;
                const hasBuyAndSell = p.buyCount > 0 && p.sellCount > 0;
                if (!hasValidHoldTime || !hasBuyAndSell) return false;
                
                // Filter by lastSellTimestamp (when position was closed)
                if (!p.lastSellTimestamp) return false;
                const sellDate = new Date(p.lastSellTimestamp);
                return sellDate >= fromDate && sellDate <= now;
              });
            
            // Sum up PnL from closed positions (v SOL)
            const totalPnl = closedPositions.reduce((sum: number, p: any) => {
              const pnl =
                p.realizedPnlUsd ??
                p.closedPnlUsd ??
                p.realizedPnlBase ??
                p.closedPnlBase ??
                p.closedPnl ??
                0;
              return sum + (typeof pnl === 'number' ? pnl : 0);
            }, 0);
            
            // Calculate total cost for percentage calculation
            // Use realizedPnlBase and realizedPnlPercent to calculate totalCost for each position
            const totalCost = closedPositions.reduce((sum: number, p: any) => {
              const pnl = p.realizedPnlBase ?? p.closedPnlBase ?? p.closedPnl ?? 0; // PnL v SOL
              const pnlPercent = p.realizedPnlPercent ?? p.closedPnlPercent ?? 0;
              
              // Calculate cost from PnL and PnL percent: cost = pnl / (pnlPercent / 100)
              if (pnlPercent !== 0 && typeof pnl === 'number' && typeof pnlPercent === 'number') {
                const cost = pnl / (pnlPercent / 100);
                return sum + Math.abs(cost);
              }
              return sum;
            }, 0);
            
            // Calculate overall PnL percentage
            const pnlPercent = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
            
            // DEBUG: Log PnL calculation on frontend
            if (days === 30 && closedPositions.length > 0) {
              console.log(`   📊 [Frontend] Wallet ${walletAddress}: Found ${closedPositions.length} closed positions in last ${days} days`);
              console.log(`   ✅ [Frontend] Wallet ${walletAddress}: totalPnl=${totalPnl.toFixed(2)}, totalCost=${totalCost.toFixed(2)}, pnlPercent=${pnlPercent.toFixed(2)}%`);
              closedPositions.forEach((p: any, idx: number) => {
                if (idx < 5) { // Log first 5 positions
                  console.log(`   💰 [Frontend] Position ${idx + 1}: tokenId=${p.tokenId}, realizedPnlBase=${(p.realizedPnlBase ?? p.closedPnlBase ?? p.closedPnl ?? 0).toFixed(2)} SOL, closedPnlPercent=${(p.realizedPnlPercent ?? p.closedPnlPercent ?? 0).toFixed(2)}%, lastSell=${p.lastSellTimestamp}`);
                }
              });
            }
            
            return {
              pnlBase: totalPnl, // nyní reprezentuje USD hodnotu
              pnlPercent,
              trades: closedPositions.length,
            };
          };
          
          const periods = [
            { key: '1d', days: 1 },
            { key: '7d', days: 7 },
            { key: '14d', days: 14 },
            { key: '30d', days: 30 },
          ];
          
          return (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
              {periods.map(({ key, days }) => {
                const data = calculatePnLForPeriod(days);
                return (
                  <div key={key} style={{ border: 'none', background: '#2323234f', backdropFilter: 'blur(20px)' }} className="p-4">
                    <div style={{ color: 'white', fontSize: '.875rem', textTransform: 'uppercase', letterSpacing: '0.03em', fontWeight: 'bold' }} className="mb-1">PnL ({key})</div>
                  <div className={`${
                    data.pnlPercent >= 0 ? 'text-green-600' : 'text-red-600'
                  }`}>
                          <span style={{ fontSize: '1.5rem', fontFamily: 'Inter, sans-serif', fontWeight: 'normal' }}>
                            ${formatNumber(Math.abs(data.pnlBase), 2)}
                          </span>
                          {' '}
                          <span style={{ fontSize: '0.875rem', fontFamily: 'Inter, sans-serif', fontWeight: 'normal' }}>
                            ({data.pnlPercent >= 0 ? '+' : ''}{formatPercent(data.pnlPercent / 100)})
                          </span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {data.trades} trades
                  </div>
                </div>
                );
              })}
            </div>
          );
        })()}

        {/* Volume Periods Overview - From API (all trades in database) */}
        {(() => {
          // Use Volume data from PnL API endpoint (calculated from all trades in database)
          const periods = [
            { key: '1d' },
            { key: '7d' },
            { key: '14d' },
            { key: '30d' },
          ];
          
          return (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
              {periods.map(({ key }) => {
                // Get Volume data from pnlData.periods (loaded from API)
                // Backend returns { periods: { '1d': {...}, '7d': {...}, ... }, daily: [...] }
                const volumeData = pnlData?.periods?.[key];
                const volumeBase = volumeData?.volumeBase ?? 0;
                const volumeTrades = volumeData?.volumeTrades ?? 0;
                
                return (
                  <div key={key} style={{ border: 'none', background: '#2323234f', backdropFilter: 'blur(20px)' }} className="p-4">
                    <div style={{ color: 'white', fontSize: '.875rem', textTransform: 'uppercase', letterSpacing: '0.03em', fontWeight: 'bold' }} className="mb-1">Volume ({key})</div>
                    <div className="text-white">
                      <span style={{ fontSize: '1.5rem', fontFamily: 'Inter, sans-serif', fontWeight: 'normal' }}>
                        ${formatNumber(volumeBase, 2)}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {volumeTrades} trades
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}

        {/* Closed Positions */}
        <div className="mb-10 w-full">
          <h2 style={{ fontSize: '2rem', marginBottom: '1rem' }} className="font-semibold">Closed Positions</h2>
          {portfolioLoading ? (
            <div className="py-4">
              <Spinner label="Loading positions..." />
            </div>
          ) : (
              <div className="overflow-hidden w-full">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-muted/30">
                      <tr>
                        <th className="px-4 py-3 text-left text-sm font-medium">DATE</th>
                        <th className="px-4 py-3 text-left text-sm font-medium">TOKEN</th>
                        <th className="px-4 py-3 text-right text-sm font-medium">PnL</th>
                        <th className="px-4 py-3 text-right text-sm font-medium">HOLD TIME</th>
                        <th className="px-4 py-3 text-right text-sm font-medium">ACTIONS</th>
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
                              <td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">
                                No closed positions
                              </td>
                            </tr>
                          );
                        }

                        const items = closedPositions.slice(0, showAllClosedPositions ? closedPositions.length : 10);
                        return items.map((position: any, index: number) => {
                          const token = position.token;
                          const closedPnlBase = position.realizedPnlBase ?? position.closedPnlBase ?? position.closedPnl ?? 0;
                          const closedPnlUsd = position.realizedPnlUsd ?? position.closedPnlUsd ?? null;
                          const closedPnlValue = closedPnlUsd ?? closedPnlBase;
                          const closedPnlPercent = position.realizedPnlPercent ?? position.closedPnlPercent ?? 0;
                          const holdTimeMinutes = position.holdTimeMinutes ?? null;
                          const sellDate = position.lastSellTimestamp
                            ? formatDate(new Date(position.lastSellTimestamp))
                            : '-';
                          const sequenceNumber = position.sequenceNumber ?? null; // Kolikátý BUY-SELL cyklus (1., 2., 3. atd.)

                          // Vytvoř unikátní klíč pro každou pozici (tokenId + sequenceNumber nebo index)
                          const positionKey = sequenceNumber 
                            ? `${position.tokenId}-${sequenceNumber}` 
                            : `${position.tokenId}-${index}`;
                          
                          const isDeleting = deletingPosition === positionKey;
                          
                          const handleDelete = async () => {
                            if (!wallet?.id) return;
                            if (!confirm(`Are you sure you want to delete this closed trade? This will permanently delete the trade and all related data.`)) {
                              return;
                            }
                            
                            setDeletingPosition(positionKey);
                            try {
                              await deletePosition(wallet.id, position.tokenId, sequenceNumber || undefined);
                              // Reload portfolio data
                              const portfolioData = await fetchWalletPortfolio(wallet.id, true);
                              setPortfolio(portfolioData);
                            } catch (error: any) {
                              console.error('Failed to delete position:', error);
                              alert(error.message || 'Failed to delete closed trade');
                            } finally {
                              setDeletingPosition(null);
                            }
                          };

                          return (
                            <tr key={positionKey} className="border-t border-border hover:bg-muted/50">
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
                                    {(() => {
                                      const tokenName = token.symbol 
                                        ? `$${token.symbol}` 
                                        : token.name 
                                        ? token.name 
                                        : `${token.mintAddress.slice(0, 6)}...${token.mintAddress.slice(-6)}`;
                                      
                                      // Přidej řadové označení, pokud sequenceNumber existuje a je > 1
                                      if (sequenceNumber !== null && sequenceNumber > 1) {
                                        return `${tokenName} (${sequenceNumber}.)`;
                                      }
                                      return tokenName;
                                    })()}
                                  </a>
                                ) : (
                                  <span className="text-muted-foreground">-</span>
                                )}
                              </td>
                              <td className={`px-4 py-3 text-right text-sm font-mono ${
                                (closedPnlValue ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
                              }`}>
                                {closedPnlValue !== null && closedPnlValue !== undefined ? (
                                  <>
                                    ${formatNumber(Math.abs(closedPnlValue), 2)} ({closedPnlPercent >= 0 ? '+' : ''}{formatPercent((closedPnlPercent || 0) / 100)})
                                  </>
                                ) : '-'}
                              </td>
                              <td className="px-4 py-3 text-right text-sm font-mono">
                                {holdTimeMinutes !== null ? formatHoldTime(holdTimeMinutes) : '-'}
                              </td>
                              <td className="px-4 py-3 text-right">
                                <button
                                  onClick={handleDelete}
                                  disabled={isDeleting || !wallet?.id}
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
          )}
        </div>
            {/* Recent Trades */}
            <div className="overflow-hidden">
              <h2 style={{ fontSize: '2rem', marginBottom: '1rem' }} className="font-semibold">Recent Trades</h2>
              {tradesLoading ? (
                <div className="py-4">
                  <Spinner label="Loading trades..." />
                </div>
              ) : (
              <>
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
                      
                      // Zobrazujeme pouze prvních displayedTradesCount trades
                      const recentTrades = allTradesSorted.slice(0, displayedTradesCount);
                      
                      if (recentTrades.length === 0) {
                        return (
                          <tr className="border-t border-border">
                            <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                              No trades found
                            </td>
                          </tr>
                        );
                      }
                      
                      return (
                        <>
                          {recentTrades.map((trade) => {
                            const side = (trade.side || '').toLowerCase();
                            const isBuy = side === 'buy';
                            const isVoid = side === 'void';
                            const liquidityType = (trade as any).meta?.liquidityType; // ADD nebo REMOVE
                            const amountToken = Number(trade.amountToken);
                            const amountBase = Number(trade.amountBase);
                            const priceBasePerToken = Number(trade.priceBasePerToken);
                            const priceUsd =
                              (trade as any).priceUsd || (trade as any).meta?.priceUsd || null;
                            const entryPrice = priceBasePerToken;
                            const amountDisplay =
                              amountToken && amountToken > 0
                              ? `${formatNumber(amountToken, 2)} $${trade.token?.symbol || trade.token?.name || ''}`.trim()
                                : `$${formatNumber(Number(trade.amountBase), 2)}`;

                            // Fialová barva pro void trades (včetně liquidity)
                            const typeColorClass = isVoid
                              ? 'bg-purple-500/20 text-purple-400'
                              : isBuy
                              ? 'bg-green-500/20 text-green-400'
                              : 'bg-red-500/20 text-red-400';
                            const valueColorClass = isVoid
                              ? 'text-purple-400'
                              : isBuy
                              ? 'text-green-400'
                              : 'text-red-400';

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
                                  <span className={`px-2 py-1 rounded text-xs font-medium ${typeColorClass}`}>
                                    {isVoid 
                                      ? (liquidityType ? `${liquidityType} LIQUIDITY` : 'VOID')
                                      : (isBuy ? 'BUY' : 'SELL')}
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
                                <td
                                  className={`px-4 py-3 text-right text-sm font-mono ${valueColorClass}`}
                                >
                            {trade.token?.mintAddress ? (
                              <a
                                  href={`https://birdeye.so/solana/token/${trade.token.mintAddress}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                  className="hover:underline cursor-pointer"
                              >
                                  {isVoid
                                    ? '-'
                                    : (priceUsd !== null && priceUsd !== undefined && priceUsd > 0
                                    ? `$${formatNumber(priceUsd, 6)}`
                                    : entryPrice > 0
                                            ? `$${formatNumber(entryPrice, 6)}`
                                        : '-')}
                              </a>
                                  ) : isVoid
                                  ? '-'
                                  : (priceUsd !== null && priceUsd !== undefined && priceUsd > 0
                                  ? `$${formatNumber(priceUsd, 6)}`
                                  : entryPrice > 0
                                      ? `$${formatNumber(entryPrice, 6)}`
                                      : '-')}
                          </td>
                                <td
                                  className={`px-4 py-3 text-right text-sm font-mono ${valueColorClass}`}
                                >
                              {trade.token?.mintAddress ? (
                                <a
                                  href={`https://birdeye.so/solana/token/${trade.token.mintAddress}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="hover:underline cursor-pointer"
                                >
                                  {isVoid ? '-' : amountDisplay}
                                </a>
                              ) : (
                                isVoid ? '-' : amountDisplay
                              )}
                            </td>
                                <td
                                  className={`px-4 py-3 text-right text-sm font-mono ${valueColorClass}`}
                                >
                                  {isVoid
                                    ? '-'
                                    : (() => {
                                        const value =
                                          amountBase;
                                        return amountBase > 0 ? `${formatNumber(Number(amountBase), 6)} SOL` : '-';
                                      })()}
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
              </>
              )}
              
              {/* Load More button */}
              {trades && trades.trades.length > 0 && (() => {
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
                
                // Zkontroluj, zda jsou ještě další trades k načtení
                // 1. Jsou ještě další trades v načtených datech, které nejsou zobrazeny
                // 2. NEBO můžeme načíst další trades z API (trades.trades.length < trades.total)
                const hasMoreInLoaded = displayedTradesCount < allTradesSorted.length;
                const hasMoreInApi = trades && trades.total > 0 && trades.trades.length < trades.total;
                const hasMoreTrades = hasMoreInLoaded || hasMoreInApi;
                
                // Debug: zobraz vždy, pokud máme trades a total > loaded
                console.log('[Load More Debug]', {
                  displayedTradesCount,
                  allTradesSortedLength: allTradesSorted.length,
                  tradesLoaded: trades?.trades.length || 0,
                  tradesTotal: trades?.total || 0,
                  hasMoreInLoaded,
                  hasMoreInApi,
                  hasMoreTrades,
                  willShowButton: hasMoreTrades,
                });
                
                // Zobraz tlačítko, pokud jsou ještě další trades k načtení
                if (!hasMoreTrades) {
                  console.log('[Load More] Button hidden - no more trades');
                  return null;
                }
                
                console.log('[Load More] Button will be shown');
                
                return (
                  <div className="mt-4 flex justify-center">
                    <button
                      onClick={loadMoreTrades}
                      disabled={loadingMoreTrades}
                      className="px-6 py-2 text-sm font-medium border border-border rounded-md bg-background hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                      {loadingMoreTrades ? (
                        <>
                          <svg className="h-4 w-4 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                          </svg>
                          Loading...
                        </>
                      ) : (
                        `Load More (${RECENT_TRADES_PER_PAGE} more)`
                      )}
                    </button>
                  </div>
                );
              })()}
              
              {(!trades || trades.trades.length === 0) && !tradesLoading && (
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
            {pnlLoading ? (
              <div className="py-12">
                <Spinner label="Loading PnL chart..." />
              </div>
            ) : pnlData && pnlData.daily && pnlData.daily.length > 0 ? (
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

