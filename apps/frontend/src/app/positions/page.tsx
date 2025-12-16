'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { formatNumber, formatDate } from '@/lib/utils';
import { Spinner } from '@/components/Spinner';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

interface Position {
  id: string;
  tokenId: string;
  entryPriceUsd: number;
  entryTime: string;
  entryWalletCount: number;
  currentPriceUsd?: number;
  unrealizedPnlPercent?: number;
  unrealizedPnlUsd?: number;
  highestPriceUsd?: number;
  maxDrawdownPercent?: number;
  activeWalletCount: number;
  exitedWalletCount: number;
  status: 'open' | 'partial_exit' | 'closed' | 'stopped';
  exitReason?: string;
  exitPriceUsd?: number;
  exitTime?: string;
  realizedPnlPercent?: number;
  lastAiDecision?: string;
  lastAiConfidence?: number;
  lastAiReasoning?: string;
  suggestedStopLoss?: number;
  suggestedTakeProfit?: number;
  holdTimeMinutes?: number;
  holdTimeFormatted?: string;
  token?: {
    symbol: string;
    mintAddress: string;
  };
}

interface ExitSignal {
  id: string;
  positionId: string;
  type: string;
  strength: string;
  recommendation: string;
  priceAtSignal?: number;
  pnlPercentAtSignal?: number;
  triggerReason?: string;
  aiDecision?: string;
  aiConfidence?: number;
  createdAt: string;
  position?: {
    token?: {
      symbol: string;
      mintAddress: string;
    };
  };
}

interface Stats {
  openPositions: number;
  closedPositions: number;
  avgOpenPnlPercent: number;
  avgClosedPnlPercent: number;
  winRate: number;
  exitSignals24h: number;
}

const EXIT_SIGNAL_TYPES: Record<string, { icon: string; label: string; color: string }> = {
  'wallet_exit': { icon: '👛', label: 'Wallet Exit', color: 'bg-orange-500/20 text-orange-400' },
  'stop_loss': { icon: '🛑', label: 'Stop Loss', color: 'bg-red-500/20 text-red-400' },
  'take_profit': { icon: '🎯', label: 'Take Profit', color: 'bg-green-500/20 text-green-400' },
  'trailing_stop': { icon: '📉', label: 'Trailing Stop', color: 'bg-yellow-500/20 text-yellow-400' },
  'ai_recommendation': { icon: '🤖', label: 'AI Recommendation', color: 'bg-purple-500/20 text-purple-400' },
  'time_based': { icon: '⏰', label: 'Time Based', color: 'bg-blue-500/20 text-blue-400' },
};

export default function PositionsPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [exitSignals, setExitSignals] = useState<ExitSignal[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'open' | 'closed' | 'all'>('open');

  const loadData = useCallback(async () => {
    try {
      const [posRes, signalsRes, statsRes] = await Promise.all([
        fetch(`${API_BASE}/positions?status=${filter}&limit=50`),
        fetch(`${API_BASE}/positions/exit-signals/recent?hours=24&limit=20`),
        fetch(`${API_BASE}/positions/stats`),
      ]);

      if (posRes.ok) {
        const data = await posRes.json();
        setPositions(data.positions || []);
      }

      if (signalsRes.ok) {
        const data = await signalsRes.json();
        setExitSignals(data.signals || []);
      }

      if (statsRes.ok) {
        const data = await statsRes.json();
        setStats(data.stats);
      }
    } catch (error) {
      console.error('Error loading positions:', error);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60000); // Refresh every minute
    return () => clearInterval(interval);
  }, [loadData]);

  const handleClosePosition = async (positionId: string) => {
    if (!confirm('Are you sure you want to close this position?')) return;
    
    try {
      const res = await fetch(`${API_BASE}/positions/${positionId}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exitReason: 'manual' }),
      });
      
      if (res.ok) {
        loadData();
      }
    } catch (error) {
      console.error('Error closing position:', error);
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-center py-20">
          <Spinner label="Loading positions..." />
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">📊 Position Monitor</h1>
          <p className="text-gray-400 text-sm mt-1">
            Sledování virtuálních pozic a exit signálů
          </p>
        </div>
        <button 
          onClick={loadData}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-white text-sm"
        >
          ↻ Refresh
        </button>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mb-6">
          <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
            <div className="text-gray-400 text-xs">Open Positions</div>
            <div className="text-2xl font-bold text-blue-400">{stats.openPositions}</div>
          </div>
          <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
            <div className="text-gray-400 text-xs">Closed</div>
            <div className="text-2xl font-bold text-gray-400">{stats.closedPositions}</div>
          </div>
          <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
            <div className="text-gray-400 text-xs">Avg Open P&L</div>
            <div className={`text-2xl font-bold ${stats.avgOpenPnlPercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {stats.avgOpenPnlPercent >= 0 ? '+' : ''}{stats.avgOpenPnlPercent.toFixed(1)}%
            </div>
          </div>
          <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
            <div className="text-gray-400 text-xs">Avg Closed P&L</div>
            <div className={`text-2xl font-bold ${stats.avgClosedPnlPercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {stats.avgClosedPnlPercent >= 0 ? '+' : ''}{stats.avgClosedPnlPercent.toFixed(1)}%
            </div>
          </div>
          <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
            <div className="text-gray-400 text-xs">Win Rate</div>
            <div className="text-2xl font-bold text-purple-400">{stats.winRate.toFixed(0)}%</div>
          </div>
          <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
            <div className="text-gray-400 text-xs">Exit Signals (24h)</div>
            <div className="text-2xl font-bold text-orange-400">{stats.exitSignals24h}</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-2 mb-6">
        {[
          { key: 'open', label: '🟢 Open Positions' },
          { key: 'closed', label: '✅ Closed' },
          { key: 'all', label: 'All' },
        ].map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key as any)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              filter === f.key
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Exit Signals (Recent) */}
      {exitSignals.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-bold text-white mb-4">🚨 Recent Exit Signals (24h)</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {exitSignals.slice(0, 4).map(signal => {
              const typeConfig = EXIT_SIGNAL_TYPES[signal.type] || EXIT_SIGNAL_TYPES['ai_recommendation'];
              return (
                <div key={signal.id} className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-1 rounded text-xs font-bold ${typeConfig.color}`}>
                        {typeConfig.icon} {typeConfig.label}
                      </span>
                      <span className="text-white font-semibold">
                        {signal.position?.token?.symbol || 'Unknown'}
                      </span>
                    </div>
                    <span className={`text-sm font-bold ${
                      signal.recommendation === 'full_exit' ? 'text-red-400' :
                      signal.recommendation === 'partial_exit' ? 'text-orange-400' : 'text-gray-400'
                    }`}>
                      {signal.recommendation?.toUpperCase().replace('_', ' ')}
                    </span>
                  </div>
                  <p className="text-gray-400 text-sm truncate">{signal.triggerReason}</p>
                  <div className="flex justify-between mt-2 text-xs text-gray-500">
                    <span>P&L: {signal.pnlPercentAtSignal !== undefined ? `${signal.pnlPercentAtSignal >= 0 ? '+' : ''}${signal.pnlPercentAtSignal.toFixed(1)}%` : '-'}</span>
                    <span>{formatDate(signal.createdAt)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Positions Table */}
      <h2 className="text-lg font-bold text-white mb-4">
        {filter === 'open' ? '🟢 Open Positions' : filter === 'closed' ? '✅ Closed Positions' : '📋 All Positions'}
      </h2>
      
      {positions.length === 0 ? (
        <div className="text-center py-12 text-gray-400 bg-gray-800/30 rounded-xl border border-gray-700">
          <div className="text-4xl mb-4">📭</div>
          <div>No positions found</div>
          <p className="text-sm mt-2">Positions are created from consensus signals</p>
        </div>
      ) : (
        <div className="bg-gray-800/30 rounded-xl border border-gray-700 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-800/50">
              <tr className="text-left text-xs text-gray-400 uppercase">
                <th className="px-4 py-3">Token</th>
                <th className="px-4 py-3">Entry</th>
                <th className="px-4 py-3">Current</th>
                <th className="px-4 py-3">P&L</th>
                <th className="px-4 py-3">Wallets</th>
                <th className="px-4 py-3">Hold Time</th>
                <th className="px-4 py-3">SL / TP</th>
                <th className="px-4 py-3">AI</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700/50">
              {positions.map(position => {
                const pnl = position.status === 'closed' 
                  ? position.realizedPnlPercent 
                  : position.unrealizedPnlPercent;
                const pnlColor = (pnl || 0) >= 0 ? 'text-green-400' : 'text-red-400';
                
                return (
                  <tr key={position.id} className="hover:bg-gray-800/30 transition-colors">
                    {/* Token */}
                    <td className="px-4 py-4">
                      <a
                        href={`https://birdeye.so/token/${position.token?.mintAddress}?chain=solana`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-white hover:text-blue-400 transition-colors"
                      >
                        {position.token?.symbol || 'Unknown'}
                      </a>
                      <div className={`text-xs mt-1 ${
                        position.status === 'open' ? 'text-green-400' :
                        position.status === 'closed' ? 'text-gray-400' : 'text-orange-400'
                      }`}>
                        {position.status.toUpperCase()}
                      </div>
                    </td>

                    {/* Entry */}
                    <td className="px-4 py-4 font-mono text-sm">
                      <div className="text-white">${formatNumber(position.entryPriceUsd, 8)}</div>
                      <div className="text-xs text-gray-500">{position.entryWalletCount} wallets</div>
                    </td>

                    {/* Current */}
                    <td className="px-4 py-4 font-mono text-sm">
                      {position.currentPriceUsd ? (
                        <>
                          <div className="text-white">${formatNumber(position.currentPriceUsd, 8)}</div>
                          {position.maxDrawdownPercent && position.maxDrawdownPercent > 10 && (
                            <div className="text-xs text-red-400">
                              Max DD: -{position.maxDrawdownPercent.toFixed(1)}%
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-gray-500">-</span>
                      )}
                    </td>

                    {/* P&L */}
                    <td className="px-4 py-4">
                      <div className={`font-bold ${pnlColor}`}>
                        {pnl !== undefined ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%` : '-'}
                      </div>
                      {position.status === 'closed' && position.exitReason && (
                        <div className="text-xs text-gray-500">{position.exitReason}</div>
                      )}
                    </td>

                    {/* Wallets */}
                    <td className="px-4 py-4 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="text-green-400">{position.activeWalletCount} holding</span>
                        {position.exitedWalletCount > 0 && (
                          <span className="text-red-400">{position.exitedWalletCount} exited</span>
                        )}
                      </div>
                    </td>

                    {/* Hold Time */}
                    <td className="px-4 py-4 text-sm text-gray-400">
                      {position.holdTimeFormatted || '-'}
                    </td>

                    {/* SL / TP */}
                    <td className="px-4 py-4 text-xs font-mono">
                      {position.suggestedStopLoss && (
                        <div className="text-red-400">
                          SL: ${formatNumber(position.suggestedStopLoss, 8)}
                        </div>
                      )}
                      {position.suggestedTakeProfit && (
                        <div className="text-green-400">
                          TP: ${formatNumber(position.suggestedTakeProfit, 8)}
                        </div>
                      )}
                    </td>

                    {/* AI */}
                    <td className="px-4 py-4 text-sm">
                      {position.lastAiDecision ? (
                        <div>
                          <div className={`font-bold ${
                            position.lastAiDecision === 'hold' ? 'text-blue-400' :
                            position.lastAiDecision === 'partial_exit' ? 'text-orange-400' :
                            'text-red-400'
                          }`}>
                            {position.lastAiDecision.toUpperCase().replace('_', ' ')}
                          </div>
                          {position.lastAiConfidence && (
                            <div className="text-xs text-gray-500">
                              {position.lastAiConfidence.toFixed(0)}% conf
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-500">-</span>
                      )}
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-4">
                      {position.status === 'open' && (
                        <button
                          onClick={() => handleClosePosition(position.id)}
                          className="px-3 py-1 bg-red-500/20 text-red-400 rounded text-xs hover:bg-red-500/30 transition-colors"
                        >
                          Close
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend */}
      <div className="mt-8 bg-gray-800/30 rounded-xl p-6 border border-gray-700">
        <h3 className="text-lg font-bold text-white mb-4">📚 Exit Signal Types</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {Object.entries(EXIT_SIGNAL_TYPES).map(([key, config]) => (
            <div key={key} className="flex items-center gap-2">
              <span className={`px-2 py-1 rounded text-xs ${config.color}`}>{config.icon}</span>
              <span className="text-gray-300 text-sm">{config.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

