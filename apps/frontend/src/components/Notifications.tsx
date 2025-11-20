'use client';

import { useState, useEffect, useRef } from 'react';
import { fetchRecentTrades } from '@/lib/api';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

interface Trade {
  id: string;
  txSignature: string;
  wallet: {
    id: string;
    address: string;
    label: string;
  };
  token: {
    id: string;
    symbol: string;
    name?: string;
    mintAddress: string;
  };
  side: 'buy' | 'sell' | 'add' | 'remove';
  amountToken: number;
  amountBase: number;
  timestamp: string;
  dex: string;
}

export default function Notifications() {
  const [isOpen, setIsOpen] = useState(false);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [lastFetchTime, setLastFetchTime] = useState<Date | null>(null);
  const [newTradesCount, setNewTradesCount] = useState(0);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const ITEMS_PER_PAGE = 20;
  const MAX_TRADES = 100;

  // Fetch recent trades
  const loadTrades = async (since?: Date) => {
    setLoading(true);
    try {
      const result = await fetchRecentTrades({
        limit: MAX_TRADES,
        since: since?.toISOString(),
      });
      
      const newTrades = result.trades || [];
      
      if (since && lastFetchTime && trades.length > 0) {
        // Count new trades by comparing IDs (more reliable than timestamp)
        const existingIds = new Set(trades.map(t => t.id));
        const trulyNew = newTrades.filter((t: Trade) => !existingIds.has(t.id));
        
        if (trulyNew.length > 0) {
          setNewTradesCount(prev => prev + trulyNew.length);
          // Update trades list with new trades at the top
          setTrades(prev => {
            const prevIds = new Set(prev.map(t => t.id));
            const newOnes = newTrades.filter((t: Trade) => !prevIds.has(t.id));
            return [...newOnes, ...prev].slice(0, MAX_TRADES);
          });
        }
      } else {
        // Initial load
        setTrades(newTrades);
        setNewTradesCount(0);
      }
      
      setLastFetchTime(new Date());
    } catch (error) {
      console.error('Error loading trades:', error);
    } finally {
      setLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    loadTrades();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll for new trades every 10 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      if (lastFetchTime && !isOpen) {
        // Only poll when sidebar is closed (to avoid unnecessary requests)
        loadTrades(lastFetchTime);
      }
    }, 10000); // 10 seconds

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastFetchTime, isOpen]);

  // Reset new trades count when sidebar opens
  useEffect(() => {
    if (isOpen) {
      setNewTradesCount(0);
      // Reload trades when opening
      loadTrades();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Close sidebar when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (sidebarRef.current && !sidebarRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const displayedTrades = trades.slice(0, page * ITEMS_PER_PAGE);
  const hasMore = trades.length > displayedTrades.length;

  const formatTimeAgo = (timestamp: string) => {
    try {
      return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
    } catch {
      return 'unknown time';
    }
  };

  const formatAmount = (amount: number, decimals: number = 2) => {
    if (amount >= 1000000) {
      return `${(amount / 1000000).toFixed(decimals)}M`;
    }
    if (amount >= 1000) {
      return `${(amount / 1000).toFixed(decimals)}K`;
    }
    return amount.toFixed(decimals);
  };

  return (
    <>
      {/* Notification Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative px-4 py-2 rounded-md hover:bg-muted transition-colors flex items-center gap-2"
        aria-label="Notifications"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          />
        </svg>
        {newTradesCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-green-500 text-white text-xs font-bold rounded-full h-5 w-5 flex items-center justify-center">
            {newTradesCount > 99 ? '99+' : newTradesCount}
          </span>
        )}
      </button>

      {/* Sidebar */}
      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/50 z-40"
            onClick={() => setIsOpen(false)}
          />
          
          {/* Sidebar */}
          <div
            ref={sidebarRef}
            className="w-96 bg-background border-l border-border z-50 flex flex-col shadow-xl"
            style={{ 
              position: 'fixed',
              right: 0,
              top: 0,
              height: '100vh'
            }}
          >
            {/* Header */}
            <div className="p-4 border-b border-border flex items-center justify-between">
              <h2 className="text-xl font-bold">Recent Trades</h2>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 hover:bg-muted rounded-md transition-colors"
                aria-label="Close"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
              {loading && trades.length === 0 ? (
                <div className="p-4 text-center text-muted-foreground">
                  Loading...
                </div>
              ) : displayedTrades.length === 0 ? (
                <div className="p-4 text-center text-muted-foreground">
                  No trades yet
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {displayedTrades.map((trade) => (
                    <div
                      key={trade.id}
                      className="p-4 hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span
                              className={`text-xs font-semibold px-2 py-0.5 rounded ${
                                trade.side === 'buy'
                                  ? 'bg-green-500/20 text-green-400'
                                  : trade.side === 'sell'
                                  ? 'bg-red-500/20 text-red-400'
                                  : trade.side === 'add'
                                  ? 'bg-blue-500/20 text-blue-400'
                                  : 'bg-orange-500/20 text-orange-400' // remove
                              }`}
                            >
                              {trade.side === 'add' ? 'ADD' : trade.side === 'remove' ? 'REM' : trade.side.toUpperCase()}
                            </span>
                            <span className="text-sm font-medium text-foreground truncate">
                              {trade.wallet.label}
                            </span>
                          </div>
                          <div className="text-sm text-muted-foreground">
                            <span className="font-medium">${trade.token.symbol}</span>
                            {' • '}
                            <span>{formatAmount(trade.amountToken)} tokens</span>
                            {' • '}
                            <span>{formatAmount(trade.amountBase, 4)} SOL</span>
                          </div>
                          <div className="text-xs text-muted-foreground mt-1">
                            {formatTimeAgo(trade.timestamp)}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Load More */}
              {hasMore && (
                <div className="p-4 border-t border-border">
                  <button
                    onClick={() => setPage(prev => prev + 1)}
                    className="w-full px-4 py-2 bg-muted hover:bg-muted/80 rounded-md transition-colors text-sm"
                  >
                    Load More ({trades.length - displayedTrades.length} remaining)
                  </button>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-border">
              <Link
                href="/trades"
                className="w-full block px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors text-center text-sm font-medium"
                onClick={() => setIsOpen(false)}
              >
                View All Trades
              </Link>
            </div>
          </div>
        </>
      )}
    </>
  );
}

