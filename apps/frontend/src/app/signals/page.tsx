'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { formatNumber, formatDate } from '@/lib/utils';
import { Spinner } from '@/components/Spinner';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

interface Signal {
  id: string;
  tokenId: string;
  tokenSymbol: string;
  tokenMint: string;
  type: 'buy' | 'sell';
  signalType: string; // consensus, whale-entry, etc.
  strength: 'weak' | 'medium' | 'strong';
  
  // Traders info
  walletCount: number;
  wallets: Array<{
    address: string;
    label?: string;
    score: number;
    tradePrice: number;
    tradeAmount: number;
    tradeTime: string;
  }>;
  avgWalletScore: number;
  
  // Prices
  entryPriceUsd: number;
  currentPriceUsd?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  priceChangePercent?: number;
  
  // Market data
  marketCapUsd?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  tokenAgeMinutes?: number;
  
  // AI Decision
  aiDecision?: 'buy' | 'sell' | 'skip' | 'hold';
  aiConfidence?: number;
  aiReasoning?: string;
  aiPositionPercent?: number;
  aiStopLossPercent?: number;
  aiTakeProfitPercent?: number;
  aiRiskScore?: number;
  
  // Status
  status: 'active' | 'executed' | 'expired' | 'closed';
  qualityScore: number;
  riskLevel: 'low' | 'medium' | 'high';
  
  // Timestamps
  firstTradeTime: string;
  latestTradeTime: string;
  createdAt: string;
  expiresAt?: string;
}

// Signal type config
const SIGNAL_TYPES: Record<string, { icon: string; label: string; color: string }> = {
  'consensus': { icon: '🤝', label: 'Consensus', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  'whale-entry': { icon: '🐋', label: 'Whale Entry', color: 'bg-purple-500/20 text-purple-400 border-purple-500/30' },
  'early-sniper': { icon: '🎯', label: 'Early Sniper', color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
  'hot-token': { icon: '🔥', label: 'Hot Token', color: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
  're-entry': { icon: '🔄', label: 'Re-entry', color: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30' },
  'momentum': { icon: '📈', label: 'Momentum', color: 'bg-green-500/20 text-green-400 border-green-500/30' },
  'accumulation': { icon: '📦', label: 'Accumulation', color: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30' },
};

export default function SignalsPage() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'ai-buy' | 'active'>('all');

  const loadSignals = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(`${API_BASE}/signals/unified?limit=50`, {
        cache: 'no-store',
      });
      
      if (!res.ok) {
        throw new Error('Failed to fetch signals');
      }
      
      const data = await res.json();
      setSignals(data.signals || []);
    } catch (err: any) {
      console.error('Error loading signals:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSignals();
    // Auto-refresh every 30 seconds
    const interval = setInterval(loadSignals, 30000);
    return () => clearInterval(interval);
  }, [loadSignals]);

  // Filter signals
  const filteredSignals = signals.filter(s => {
    if (filter === 'ai-buy') return s.aiDecision === 'buy' && (s.aiConfidence || 0) >= 60;
    if (filter === 'active') return s.status === 'active';
    return true;
  });

  // Stats
  const stats = {
    total: signals.length,
    aiBuy: signals.filter(s => s.aiDecision === 'buy').length,
    active: signals.filter(s => s.status === 'active').length,
    avgConfidence: signals.filter(s => s.aiConfidence).reduce((sum, s) => sum + (s.aiConfidence || 0), 0) / (signals.filter(s => s.aiConfidence).length || 1),
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-center py-20">
          <Spinner label="Loading signals..." />
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">📊 Trading Signals</h1>
          <p className="text-gray-400 text-sm mt-1">
            AI-powered signály pro copytrading
          </p>
        </div>
        <button 
          onClick={loadSignals}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-white text-sm"
        >
          ↻ Refresh
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
          <div className="text-gray-400 text-xs">Total Signals</div>
          <div className="text-2xl font-bold text-white">{stats.total}</div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
          <div className="text-gray-400 text-xs">AI Recommends BUY</div>
          <div className="text-2xl font-bold text-green-400">{stats.aiBuy}</div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
          <div className="text-gray-400 text-xs">Active</div>
          <div className="text-2xl font-bold text-blue-400">{stats.active}</div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
          <div className="text-gray-400 text-xs">Avg AI Confidence</div>
          <div className="text-2xl font-bold text-purple-400">{stats.avgConfidence.toFixed(0)}%</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 mb-6">
        {[
          { key: 'all', label: 'All Signals' },
          { key: 'ai-buy', label: '🤖 AI Recommends BUY' },
          { key: 'active', label: 'Active Only' },
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

      {error && (
        <div className="bg-red-500/20 border border-red-500/30 rounded-lg p-4 mb-6 text-red-400">
          {error}
        </div>
      )}

      {/* Signals Table */}
      {filteredSignals.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <div className="text-4xl mb-4">📭</div>
          <div>No signals found</div>
        </div>
      ) : (
        <div className="bg-gray-800/30 rounded-xl border border-gray-700 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-800/50">
              <tr className="text-left text-xs text-gray-400 uppercase">
                <th className="px-4 py-3">Token</th>
                <th className="px-4 py-3">Signal</th>
                <th className="px-4 py-3">Wallets</th>
                <th className="px-4 py-3">Entry Price</th>
                <th className="px-4 py-3">Market Data</th>
                <th className="px-4 py-3">AI Decision</th>
                <th className="px-4 py-3">SL / TP</th>
                <th className="px-4 py-3">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700/50">
              {filteredSignals.map(signal => {
                const typeConfig = SIGNAL_TYPES[signal.signalType] || SIGNAL_TYPES['consensus'];
                
                return (
                  <tr key={signal.id} className="hover:bg-gray-800/30 transition-colors">
                    {/* Token */}
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-2">
                        <div>
                          <a
                            href={`https://birdeye.so/token/${signal.tokenMint}?chain=solana`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-semibold text-white hover:text-blue-400 transition-colors"
                          >
                            {signal.tokenSymbol || 'Unknown'}
                          </a>
                          <div className="flex gap-2 mt-1">
                            <a
                              href={`https://birdeye.so/token/${signal.tokenMint}?chain=solana`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-gray-500 hover:text-green-400"
                              title="View on Birdeye"
                            >
                              🦅 Birdeye
                            </a>
                            <a
                              href={`https://solscan.io/token/${signal.tokenMint}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-gray-500 hover:text-blue-400"
                              title="View on Solscan"
                            >
                              🔍 Solscan
                            </a>
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Signal Type */}
                    <td className="px-4 py-4">
                      <div className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border ${typeConfig.color}`}>
                        <span>{typeConfig.icon}</span>
                        <span>{typeConfig.label}</span>
                      </div>
                      <div className="mt-1">
                        <span className={`text-xs ${
                          signal.strength === 'strong' ? 'text-green-400' :
                          signal.strength === 'medium' ? 'text-yellow-400' : 'text-gray-400'
                        }`}>
                          {signal.strength?.toUpperCase()}
                        </span>
                      </div>
                    </td>

                    {/* Wallets */}
                    <td className="px-4 py-4">
                      <div className="text-white font-medium">{signal.walletCount} wallets</div>
                      <div className="text-xs text-gray-400">
                        Avg score: {signal.avgWalletScore?.toFixed(0) || '-'}
                      </div>
                      {signal.wallets?.slice(0, 2).map((w, i) => (
                        <div key={i} className="text-xs text-gray-500 truncate max-w-[120px]">
                          {w.label || w.address?.substring(0, 8)}...
                        </div>
                      ))}
                    </td>

                    {/* Entry Price */}
                    <td className="px-4 py-4">
                      <div className="text-white font-mono">
                        ${formatNumber(signal.entryPriceUsd, 6)}
                      </div>
                      {signal.priceChangePercent !== undefined && (
                        <div className={`text-xs ${signal.priceChangePercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {signal.priceChangePercent >= 0 ? '+' : ''}{signal.priceChangePercent.toFixed(1)}%
                        </div>
                      )}
                    </td>

                    {/* Market Data */}
                    <td className="px-4 py-4 text-xs">
                      {signal.marketCapUsd && (
                        <div className="text-gray-300">
                          MCap: <span className="text-white">${formatNumber(signal.marketCapUsd, 0)}</span>
                        </div>
                      )}
                      {signal.liquidityUsd && (
                        <div className="text-gray-300">
                          Liq: <span className="text-white">${formatNumber(signal.liquidityUsd, 0)}</span>
                        </div>
                      )}
                      {signal.tokenAgeMinutes && (
                        <div className="text-gray-300">
                          Age: <span className="text-white">
                            {signal.tokenAgeMinutes >= 60 
                              ? `${Math.round(signal.tokenAgeMinutes / 60)}h` 
                              : `${signal.tokenAgeMinutes}m`}
                          </span>
                        </div>
                      )}
                    </td>

                    {/* AI Decision */}
                    <td className="px-4 py-4">
                      {signal.aiDecision ? (
                        <div>
                          <div className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-bold ${
                            signal.aiDecision === 'buy' ? 'bg-green-500/20 text-green-400' :
                            signal.aiDecision === 'skip' ? 'bg-gray-500/20 text-gray-400' :
                            'bg-red-500/20 text-red-400'
                          }`}>
                            🤖 {signal.aiDecision.toUpperCase()}
                          </div>
                          <div className="text-xs text-gray-400 mt-1">
                            {signal.aiConfidence?.toFixed(0)}% confident
                          </div>
                          {signal.aiPositionPercent && (
                            <div className="text-xs text-blue-400">
                              Position: {signal.aiPositionPercent}%
                            </div>
                          )}
                          {signal.aiRiskScore && (
                            <div className={`text-xs ${
                              signal.aiRiskScore <= 3 ? 'text-green-400' :
                              signal.aiRiskScore <= 6 ? 'text-yellow-400' : 'text-red-400'
                            }`}>
                              Risk: {signal.aiRiskScore}/10
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-500 text-xs">Not evaluated</span>
                      )}
                    </td>

                    {/* SL / TP */}
                    <td className="px-4 py-4 text-xs font-mono">
                      {signal.stopLossPrice && (
                        <div className="text-red-400">
                          SL: ${formatNumber(signal.stopLossPrice, 6)}
                          {signal.aiStopLossPercent && (
                            <span className="text-gray-500 ml-1">(-{signal.aiStopLossPercent}%)</span>
                          )}
                        </div>
                      )}
                      {signal.takeProfitPrice && (
                        <div className="text-green-400">
                          TP: ${formatNumber(signal.takeProfitPrice, 6)}
                          {signal.aiTakeProfitPercent && (
                            <span className="text-gray-500 ml-1">(+{signal.aiTakeProfitPercent}%)</span>
                          )}
                        </div>
                      )}
                      {!signal.stopLossPrice && !signal.takeProfitPrice && (
                        <span className="text-gray-500">-</span>
                      )}
                    </td>

                    {/* Time */}
                    <td className="px-4 py-4 text-xs text-gray-400">
                      <div>{formatDate(signal.latestTradeTime || signal.createdAt)}</div>
                      <div className={`mt-1 ${
                        signal.status === 'active' ? 'text-green-400' : 'text-gray-500'
                      }`}>
                        {signal.status}
                      </div>
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
        <h3 className="text-lg font-bold text-white mb-4">📚 Signal Types</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Object.entries(SIGNAL_TYPES).map(([key, config]) => (
            <div key={key} className="flex items-center gap-2">
              <span className="text-xl">{config.icon}</span>
              <span className="text-gray-300 text-sm">{config.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
