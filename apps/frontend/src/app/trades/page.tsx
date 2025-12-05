'use client';

import { useState, useEffect } from 'react';
import { fetchRecentTrades } from '@/lib/api';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { formatDate } from '@/lib/utils';

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
  side: 'buy' | 'sell' | 'void';
  amountToken: number;
  amountBase: number;
  timestamp: string;
  dex: string;
  meta?: {
    liquidityType?: 'ADD' | 'REMOVE';
    [key: string]: any;
  };
}

export default function TradesPage() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const ITEMS_PER_PAGE = 50;

  useEffect(() => {
    loadTrades();
  }, []);

  const loadTrades = async () => {
    setLoading(true);
    try {
      const result = await fetchRecentTrades({ limit: 1000 });
      setTrades(result.trades || []);
    } catch (error) {
      console.error('Error loading trades:', error);
    } finally {
      setLoading(false);
    }
  };

  const displayedTrades = trades.slice(0, page * ITEMS_PER_PAGE);
  const hasMore = trades.length > displayedTrades.length;

  const formatAmount = (amount: number, decimals: number = 2) => {
    if (amount >= 1000000) {
      return `${(amount / 1000000).toFixed(decimals)}M`;
    }
    if (amount >= 1000) {
      return `${(amount / 1000).toFixed(decimals)}K`;
    }
    return amount.toFixed(decimals);
  };

  const formatTimeAgo = (timestamp: string) => {
    try {
      return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
    } catch {
      return 'unknown time';
    }
  };

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="container mx-auto max-w-7xl">
        <div className="mb-8">
          <h1 className="text-4xl mb-2">All Trades</h1>
          <p className="text-muted-foreground">
            Complete list of all trades from all tracked wallets
          </p>
        </div>

        {loading ? (
          <div className="text-center py-12 text-muted-foreground">
            Loading trades...
          </div>
        ) : trades.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            No trades found
          </div>
        ) : (
          <>
            <div className="bg-card border border-border rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-muted">
                    <tr>
                      <th className="px-4 py-3 text-left text-sm font-medium">Time</th>
                      <th className="px-4 py-3 text-left text-sm font-medium">Wallet</th>
                      <th className="px-4 py-3 text-left text-sm font-medium">Type</th>
                      <th className="px-4 py-3 text-left text-sm font-medium">Token</th>
                      <th className="px-4 py-3 text-right text-sm font-medium">Amount</th>
                      <th className="px-4 py-3 text-right text-sm font-medium">Base</th>
                      <th className="px-4 py-3 text-left text-sm font-medium">DEX</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {displayedTrades.map((trade) => (
                      <tr key={trade.id} className="hover:bg-muted/50 transition-colors">
                        <td className="px-4 py-3 text-sm">
                          <div className="flex flex-col">
                            <span className="text-muted-foreground text-xs">
                              {formatTimeAgo(trade.timestamp)}
                            </span>
                            <span className="text-xs text-muted-foreground/70">
                              {formatDate(trade.timestamp)}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <Link
                            href={`/wallet/${trade.wallet.address}`}
                            className="text-primary hover:underline"
                          >
                            {trade.wallet.label}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {(() => {
                            const normalizedSide = (trade.side || '').toLowerCase();
                            const isBuy = normalizedSide === 'buy';
                            const isVoid = normalizedSide === 'void';
                            const liquidityType = (trade.meta as any)?.liquidityType; // 'ADD' or 'REMOVE'
                            const isLiquidity = isVoid && (liquidityType === 'ADD' || liquidityType === 'REMOVE');
                            
                            let label = isBuy ? 'BUY' : isVoid ? 'VOID' : 'SELL';
                            if (isLiquidity) {
                              label = `${liquidityType} LIQUIDITY`;
                            }
                            
                            return (
                              <span
                                className={`text-xs font-semibold px-2 py-1 rounded ${
                                  isLiquidity || isVoid
                                    ? 'bg-purple-500/20 text-purple-400'
                                    : isBuy
                                    ? 'bg-green-500/20 text-green-400'
                                    : 'bg-red-500/20 text-red-400'
                                }`}
                              >
                                {label}
                              </span>
                            );
                          })()}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <div className="flex flex-col">
                            <span className="font-medium">${trade.token.symbol}</span>
                            {trade.token.name && (
                              <span className="text-xs text-muted-foreground">
                                {trade.token.name}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-right">
                          {formatAmount(trade.amountToken)}
                        </td>
                        <td className={`px-4 py-3 text-sm text-right ${
                          (() => {
                            const normalizedSide = (trade.side || '').toLowerCase();
                            const isVoid = normalizedSide === 'void';
                            const liquidityType = (trade.meta as any)?.liquidityType;
                            const isLiquidity = isVoid && (liquidityType === 'ADD' || liquidityType === 'REMOVE');
                            return isLiquidity || isVoid ? 'text-purple-400' : '';
                          })()
                        }`}>
                          {(() => {
                            const normalizedSide = (trade.side || '').toLowerCase();
                            const isVoid = normalizedSide === 'void';
                            const liquidityType = (trade.meta as any)?.liquidityType;
                            const isLiquidity = isVoid && (liquidityType === 'ADD' || liquidityType === 'REMOVE');
                            if (isLiquidity || isVoid) {
                              return <span className="text-purple-400">void</span>;
                            }
                            return `$${formatAmount(trade.amountBase, 2)}`;
                          })()}
                        </td>
                        <td className="px-4 py-3 text-sm text-muted-foreground">
                          {trade.dex}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {hasMore && (
              <div className="mt-6 text-center">
                <button
                  onClick={() => setPage(prev => prev + 1)}
                  className="px-6 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
                >
                  Load More ({trades.length - displayedTrades.length} remaining)
                </button>
              </div>
            )}

            <div className="mt-4 text-center text-sm text-muted-foreground">
              Showing {displayedTrades.length} of {trades.length} trades
            </div>
          </>
        )}
      </div>
    </div>
  );
}

