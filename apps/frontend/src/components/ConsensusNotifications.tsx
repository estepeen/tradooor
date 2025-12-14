'use client';

import { useState, useEffect, useRef } from 'react';
import { fetchConsensusNotifications } from '@/lib/api';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

interface ConsensusTrade {
  id: string;
  wallet: {
    id: string;
    address: string;
    label: string;
  };
  amountBase: number;
  amountToken: number;
  priceBasePerToken: number;
  timestamp: string;
  txSignature: string;
}

interface ConsensusNotification {
  id: string;
  tokenId: string;
  token: {
    id: string;
    symbol: string;
    name?: string;
    mintAddress: string;
  };
  walletCount: number;
  trades: ConsensusTrade[];
  firstTradeTime: string;
  latestTradeTime: string;
  createdAt: string;
}

const STORAGE_KEY_LAST_SEEN_CONSENSUS_ID = 'tradooor_last_seen_consensus_id';
const STORAGE_KEY_NEW_CONSENSUS_COUNT = 'tradooor_new_consensus_count';

export default function ConsensusNotifications() {
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<ConsensusNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [lastFetchTime, setLastFetchTime] = useState<Date | null>(null);
  const [newNotificationsCount, setNewNotificationsCount] = useState(0);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const ITEMS_PER_PAGE = 20;
  const MAX_NOTIFICATIONS = 100;

  // Load persisted new notifications count from localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedCount = localStorage.getItem(STORAGE_KEY_NEW_CONSENSUS_COUNT);
      if (savedCount) {
        const count = parseInt(savedCount, 10);
        if (!isNaN(count) && count > 0) {
          setNewNotificationsCount(count);
        }
      }
    }
  }, []);

  // Save new notifications count to localStorage whenever it changes
  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (newNotificationsCount > 0) {
        localStorage.setItem(STORAGE_KEY_NEW_CONSENSUS_COUNT, newNotificationsCount.toString());
      } else {
        localStorage.removeItem(STORAGE_KEY_NEW_CONSENSUS_COUNT);
      }
    }
  }, [newNotificationsCount]);

  // Fetch consensus notifications
  const loadNotifications = async (since?: Date) => {
    // Only fetch on client side
    if (typeof window === 'undefined') return;
    
    setLoading(true);
    try {
      const result = await fetchConsensusNotifications({
        hours: 1, // Last hour
        limit: MAX_NOTIFICATIONS,
      });
      
      const newNotifications = result.notifications || [];
      
      if (since && lastFetchTime && notifications.length > 0) {
        // Count new notifications by comparing IDs
        const existingIds = new Set(notifications.map(n => n.id));
        const trulyNew = newNotifications.filter((n: ConsensusNotification) => !existingIds.has(n.id));
        
        // Also check for updated notifications (new wallets added)
        const updated = newNotifications.filter((n: ConsensusNotification) => {
          const existing = notifications.find(en => en.id === n.id);
          if (!existing) return false;
          return n.walletCount > existing.walletCount || 
                 new Date(n.latestTradeTime).getTime() > new Date(existing.latestTradeTime).getTime();
        });
        
        if (trulyNew.length > 0 || updated.length > 0) {
          setNewNotificationsCount(prev => prev + trulyNew.length + updated.length);
          // Update notifications list
          setNotifications(prev => {
            const prevIds = new Set(prev.map(n => n.id));
            const newOnes = newNotifications.filter((n: ConsensusNotification) => !prevIds.has(n.id));
            const updatedOnes = newNotifications.filter((n: ConsensusNotification) => {
              const existing = prev.find(p => p.id === n.id);
              return existing && (n.walletCount > existing.walletCount || 
                     new Date(n.latestTradeTime).getTime() > new Date(existing.latestTradeTime).getTime());
            });
            // Merge: keep existing, update changed, add new
            // Pokud se aktualizovala notifikace (přidal se trader), přesuň ji úplně nahoru
            const merged = prev.map(p => {
              const updated = updatedOnes.find((u: ConsensusNotification) => u.id === p.id);
              return updated || p;
            });
            
            // Odděl aktualizované (přesunou se nahoru) a neaktualizované
            const updatedIds = new Set(updatedOnes.map((u: ConsensusNotification) => u.id));
            const notUpdated = merged.filter(p => !updatedIds.has(p.id));
            const updated = merged.filter(p => updatedIds.has(p.id));
            
            // Seřaď aktualizované podle nejnovějšího času
            updated.sort((a, b) => 
              new Date(b.latestTradeTime).getTime() - new Date(a.latestTradeTime).getTime()
            );
            
            // Nové + aktualizované (nahoře) + neaktualizované
            return [...newOnes, ...updated, ...notUpdated].slice(0, MAX_NOTIFICATIONS);
          });
        }
      } else {
        // Initial load - check for new notifications since last seen
        if (typeof window !== 'undefined' && newNotifications.length > 0) {
          const lastSeenId = localStorage.getItem(STORAGE_KEY_LAST_SEEN_CONSENSUS_ID);
          if (lastSeenId) {
            const lastSeenIndex = newNotifications.findIndex((n: ConsensusNotification) => n.id === lastSeenId);
            if (lastSeenIndex > 0) {
              const newCount = lastSeenIndex;
              setNewNotificationsCount(newCount);
            } else if (lastSeenIndex === -1) {
              setNewNotificationsCount(newNotifications.length);
            }
          } else {
            setNewNotificationsCount(0);
          }
        } else {
          setNewNotificationsCount(0);
        }
        setNotifications(newNotifications);
      }
      
      setLastFetchTime(new Date());
    } catch (error) {
      console.error('Error loading consensus notifications:', error);
    } finally {
      setLoading(false);
    }
  };

  // Initial load - only on client side
  useEffect(() => {
    if (typeof window !== 'undefined') {
      loadNotifications();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll for new notifications every 10 seconds - only on client side
  useEffect(() => {
    if (typeof window === 'undefined') return;
    
    const interval = setInterval(() => {
      if (lastFetchTime) {
        loadNotifications(lastFetchTime);
      }
    }, 10000); // 10 seconds

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastFetchTime]);

  // Reset new notifications count when sidebar opens and save last seen notification ID
  useEffect(() => {
    if (isOpen) {
      setNewNotificationsCount(0);
      if (typeof window !== 'undefined' && notifications.length > 0) {
        const mostRecentId = notifications[0]?.id;
        if (mostRecentId) {
          localStorage.setItem(STORAGE_KEY_LAST_SEEN_CONSENSUS_ID, mostRecentId);
        }
        localStorage.removeItem(STORAGE_KEY_NEW_CONSENSUS_COUNT);
      }
      loadNotifications();
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

  const displayedNotifications = notifications.slice(0, page * ITEMS_PER_PAGE);
  const hasMore = notifications.length > displayedNotifications.length;

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
      {/* Consensus Notification Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative px-4 py-2 rounded-md hover:bg-muted transition-colors flex items-center gap-2"
        aria-label="Consensus Notifications"
      >
        {/* Diamond Icon */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 2l9 9-9 9-9-9 9-9z"
          />
        </svg>
        {newNotificationsCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-blue-500 text-white text-xs font-bold rounded-full h-5 w-5 flex items-center justify-center">
            {newNotificationsCount > 99 ? '99+' : newNotificationsCount}
          </span>
        )}
      </button>

      {/* Sidebar */}
      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/50"
            style={{ zIndex: 9998 }}
            onClick={() => setIsOpen(false)}
          />
          
          {/* Sidebar */}
          <div
            ref={sidebarRef}
            className="w-96 bg-background border-l border-border flex flex-col shadow-xl"
            style={{ 
              position: 'fixed',
              right: 0,
              top: 0,
              height: '100vh',
              zIndex: 9999,
              overflow: 'hidden'
            }}
          >
            {/* Header */}
            <div className="p-4 border-b border-border flex items-center justify-between">
              <h2 className="text-xl font-bold">Consensus Trading</h2>
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
            <div className="flex-1 overflow-y-auto overflow-x-hidden">
              {loading && notifications.length === 0 ? (
                <div className="p-4 text-center text-muted-foreground">
                  Loading...
                </div>
              ) : displayedNotifications.length === 0 ? (
                <div className="p-4 text-center text-muted-foreground">
                  No consensus trades yet
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {displayedNotifications.map((notification) => (
                    <div
                      key={notification.id}
                      className="p-4 hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs font-semibold px-2 py-0.5 rounded bg-blue-500/20 text-blue-400">
                              CONSENSUS
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {notification.walletCount} wallet{notification.walletCount > 1 ? 's' : ''}
                            </span>
                          </div>
                          <div className="mb-2">
                            {notification.token.mintAddress ? (
                              <a
                                href={`https://birdeye.so/solana/token/${notification.token.mintAddress}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-medium text-foreground hover:underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                ${notification.token.symbol}
                              </a>
                            ) : (
                              <span className="font-medium text-foreground">${notification.token.symbol}</span>
                            )}
                          </div>
                          <div className="space-y-1 mb-2">
                            {notification.trades.map((trade, idx) => (
                              <div key={trade.id} className="text-sm text-muted-foreground">
                                <Link
                                  href={`/wallet/${trade.wallet.address}`}
                                  className="font-medium hover:underline"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {trade.wallet.label}
                                </Link>
                                {' • '}
                                <span>{formatAmount(trade.amountToken)} tokens</span>
                                {' • '}
                                <span>${formatAmount(trade.amountBase, 2)}</span>
                                {' • '}
                                <span className="text-xs">{formatTimeAgo(trade.timestamp)}</span>
                              </div>
                            ))}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            First trade: {formatTimeAgo(notification.firstTradeTime)}
                            {' • '}
                            Latest: {formatTimeAgo(notification.latestTradeTime)}
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
                    Load More ({notifications.length - displayedNotifications.length} remaining)
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
