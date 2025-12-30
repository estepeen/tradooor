'use client';

import { useEffect, useState, useCallback } from 'react';
import { formatNumber, formatDate } from '@/lib/utils';
import { Spinner } from '@/components/Spinner';
import { getApiBaseUrl } from '@/lib/api';

interface SignalPerformance {
  id: string;
  signalId: string;
  tokenId: string;
  tokenSymbol: string;
  tokenMint: string;
  signalType: string;
  strength: string;
  entryPriceUsd: number;
  entryTimestamp: string;
  currentPriceUsd: number | null;
  highestPriceUsd: number | null;
  currentPnlPercent: number | null;
  maxPnlPercent: number | null;
  realizedPnlPercent: number | null;
  missedPnlPercent: number | null;
  drawdownFromPeak: number | null;
  timeToPeakMinutes: number | null;
  status: 'active' | 'closed' | 'expired';
  exitReason: string | null;
  pnlSnapshots: Record<string, number> | null;
  // AI Analysis data
  aiDecision: 'buy' | 'skip' | 'sell' | null;
  aiConfidence: number | null;
  aiPositionPercent: number | null;
  aiRiskScore: number | null;
  // Exit Strategy data
  stopLossPercent: number | null;
  takeProfitPercent: number | null;
  stopLossPriceUsd: number | null;
  takeProfitPriceUsd: number | null;
}

interface Analytics {
  totalSignals: number;
  activeSignals: number;
  closedSignals: number;
  avgMaxPnl: number;
  avgRealizedPnl: number;
  avgMissedPnl: number;
  avgTimeToPeakMinutes: number;
  winRate: number;
  byMilestone: Record<string, { avgPnl: number; count: number }>;
}

interface AIAccuracy {
  total: number;
  buyCorrect: number;
  buyWrong: number;
  skipCorrect: number;
  skipWrong: number;
}

interface WinRateByType {
  [key: string]: {
    total: number;
    wins: number;
    avgPnl: number;
    avgMissed: number;
  };
}

interface MissedGains {
  totalMissed: number;
  avgMissed: number;
  maxMissed: number;
  signalsWithMissed50Plus: number;
  signalsWithMissed100Plus: number;
}

interface DashboardData {
  analytics: Analytics;
  signalsTable: SignalPerformance[];
  aiAccuracy: AIAccuracy;
  winRateByType: WinRateByType;
  missedGains: MissedGains;
  period: { days: number; startDate: string; endDate: string };
}

const SIGNAL_TYPE_CONFIG: Record<string, { icon: string; label: string; color: string }> = {
  'consensus': { icon: '🤝', label: 'Consensus', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  'conviction-buy': { icon: '💪', label: 'Conviction', color: 'bg-pink-500/20 text-pink-400 border-pink-500/30' },
  'accumulation': { icon: '📦', label: 'Accumulation', color: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30' },
  'whale-entry': { icon: '🐋', label: 'Whale', color: 'bg-purple-500/20 text-purple-400 border-purple-500/30' },
  'early-sniper': { icon: '🎯', label: 'Sniper', color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
  'momentum': { icon: '📈', label: 'Momentum', color: 'bg-green-500/20 text-green-400 border-green-500/30' },
};

export default function SignalsAnalyticsPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<number>(7);
  const [activeTab, setActiveTab] = useState<'table' | 'missed' | 'ai' | 'types'>('table');

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`${getApiBaseUrl()}/signals/analytics/dashboard?days=${period}`, {
        cache: 'no-store',
      });

      if (!res.ok) {
        throw new Error('Failed to fetch analytics');
      }

      const result = await res.json();
      if (result.success) {
        setData(result);
      } else {
        throw new Error(result.error || 'Unknown error');
      }
    } catch (err: any) {
      console.error('Error loading analytics:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-center py-20">
          <Spinner label="Loading analytics..." />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="bg-red-500/20 border border-red-500/30 rounded-lg p-4 text-red-400">
          Error: {error}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { analytics, signalsTable, aiAccuracy, winRateByType, missedGains } = data;

  // Calculate AI accuracy percentage
  const aiTotalDecisions = aiAccuracy.buyCorrect + aiAccuracy.buyWrong + aiAccuracy.skipCorrect + aiAccuracy.skipWrong;
  const aiCorrectDecisions = aiAccuracy.buyCorrect + aiAccuracy.skipCorrect;
  const aiAccuracyPercent = aiTotalDecisions > 0 ? (aiCorrectDecisions / aiTotalDecisions) * 100 : 0;

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Signal Analytics</h1>
          <p className="text-gray-400 text-sm mt-1">
            Performance tracking & missed gains analysis
          </p>
        </div>
        <div className="flex items-center gap-4">
          {/* Period Selector */}
          <div className="flex gap-2">
            {[7, 14, 30].map(d => (
              <button
                key={d}
                onClick={() => setPeriod(d)}
                className={`px-3 py-1 rounded text-sm ${
                  period === d
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
          <button
            onClick={loadData}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-white text-sm"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-6">
        <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
          <div className="text-gray-400 text-xs">Total Signals</div>
          <div className="text-2xl font-bold text-white">{analytics.totalSignals}</div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
          <div className="text-gray-400 text-xs">Active</div>
          <div className="text-2xl font-bold text-blue-400">{analytics.activeSignals}</div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
          <div className="text-gray-400 text-xs">Win Rate</div>
          <div className={`text-2xl font-bold ${analytics.winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
            {analytics.winRate.toFixed(0)}%
          </div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
          <div className="text-gray-400 text-xs">Avg Max P&L</div>
          <div className={`text-2xl font-bold ${analytics.avgMaxPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {analytics.avgMaxPnl >= 0 ? '+' : ''}{analytics.avgMaxPnl.toFixed(1)}%
          </div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
          <div className="text-gray-400 text-xs">Avg Realized</div>
          <div className={`text-2xl font-bold ${analytics.avgRealizedPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {analytics.avgRealizedPnl >= 0 ? '+' : ''}{analytics.avgRealizedPnl.toFixed(1)}%
          </div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
          <div className="text-gray-400 text-xs">Avg Missed</div>
          <div className="text-2xl font-bold text-orange-400">
            {analytics.avgMissedPnl.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6 border-b border-gray-700 pb-2">
        {[
          { key: 'table', label: 'Signals Table', icon: '📋' },
          { key: 'missed', label: 'Missed Gains', icon: '💸' },
          { key: 'ai', label: 'AI Accuracy', icon: '🤖' },
          { key: 'types', label: 'Win Rate by Type', icon: '📊' },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key as any)}
            className={`px-4 py-2 rounded-t-lg text-sm font-medium transition-all ${
              activeTab === tab.key
                ? 'bg-gray-800 text-white border-b-2 border-blue-500'
                : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
            }`}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="bg-gray-800/30 rounded-xl border border-gray-700">
        {/* Signals Table */}
        {activeTab === 'table' && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-800/50">
                <tr className="text-left text-xs text-gray-400 uppercase">
                  <th className="px-4 py-3">Token</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">AI Analysis</th>
                  <th className="px-4 py-3">Exit Strategy</th>
                  <th className="px-4 py-3">Entry</th>
                  <th className="px-4 py-3">Current P&L</th>
                  <th className="px-4 py-3">Max P&L</th>
                  <th className="px-4 py-3">Realized</th>
                  <th className="px-4 py-3">Missed</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700/50">
                {signalsTable.map(signal => {
                  const typeConfig = SIGNAL_TYPE_CONFIG[signal.signalType] || {
                    icon: '📊', label: signal.signalType, color: 'bg-gray-500/20 text-gray-400'
                  };

                  // AI Decision styling
                  const getAIDecisionStyle = (decision: string | null) => {
                    if (!decision) return { emoji: '-', color: 'text-gray-500' };
                    switch (decision) {
                      case 'buy': return { emoji: '✅', color: 'text-green-400' };
                      case 'skip': return { emoji: '⏭️', color: 'text-yellow-400' };
                      case 'sell': return { emoji: '❌', color: 'text-red-400' };
                      default: return { emoji: '-', color: 'text-gray-500' };
                    }
                  };

                  const getRiskColor = (risk: number | null) => {
                    if (!risk) return 'text-gray-500';
                    if (risk <= 3) return 'text-green-400';
                    if (risk <= 6) return 'text-yellow-400';
                    return 'text-red-400';
                  };

                  const aiStyle = getAIDecisionStyle(signal.aiDecision);

                  return (
                    <tr key={signal.id} className="hover:bg-gray-800/30 transition-colors">
                      <td className="px-4 py-3">
                        <a
                          href={`https://birdeye.so/token/${signal.tokenMint}?chain=solana`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-semibold text-white hover:text-blue-400"
                        >
                          {signal.tokenSymbol}
                        </a>
                        <div className="text-xs text-gray-500">{formatDate(signal.entryTimestamp)}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs ${typeConfig.color}`}>
                          {typeConfig.icon} {typeConfig.label}
                        </span>
                        <div className="text-xs text-gray-500 mt-1">{signal.strength}</div>
                      </td>
                      {/* AI Analysis Column */}
                      <td className="px-4 py-3">
                        <div className="text-xs space-y-0.5">
                          <div className={aiStyle.color}>
                            {aiStyle.emoji} {signal.aiDecision?.toUpperCase() || '-'}
                          </div>
                          <div className="text-gray-400">
                            Conf: {signal.aiConfidence ? `${signal.aiConfidence}%` : '-'}
                          </div>
                          <div className="text-gray-400">
                            Pos: {signal.aiPositionPercent ? `${signal.aiPositionPercent}%` : '-'}
                          </div>
                          <div className={getRiskColor(signal.aiRiskScore)}>
                            Risk: {signal.aiRiskScore ? `${signal.aiRiskScore}/10` : '-'}
                          </div>
                        </div>
                      </td>
                      {/* Exit Strategy Column */}
                      <td className="px-4 py-3">
                        <div className="text-xs space-y-0.5">
                          <div className="text-red-400">
                            🛑 SL: {signal.stopLossPercent ? `-${signal.stopLossPercent}%` : '-'}
                          </div>
                          <div className="text-green-400">
                            🎯 TP: {signal.takeProfitPercent ? `+${signal.takeProfitPercent}%` : '-'}
                          </div>
                          {signal.stopLossPriceUsd && (
                            <div className="text-gray-500 text-[10px]">
                              ${formatNumber(signal.stopLossPriceUsd, 8)}
                            </div>
                          )}
                          {signal.takeProfitPriceUsd && (
                            <div className="text-gray-500 text-[10px]">
                              ${formatNumber(signal.takeProfitPriceUsd, 8)}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-sm text-white">
                        ${formatNumber(signal.entryPriceUsd, 8)}
                      </td>
                      <td className="px-4 py-3">
                        {signal.currentPnlPercent !== null ? (
                          <span className={signal.currentPnlPercent >= 0 ? 'text-green-400' : 'text-red-400'}>
                            {signal.currentPnlPercent >= 0 ? '+' : ''}{signal.currentPnlPercent.toFixed(1)}%
                          </span>
                        ) : '-'}
                      </td>
                      <td className="px-4 py-3">
                        {signal.maxPnlPercent !== null ? (
                          <span className="text-green-400 font-medium">
                            +{signal.maxPnlPercent.toFixed(1)}%
                          </span>
                        ) : '-'}
                      </td>
                      <td className="px-4 py-3">
                        {signal.realizedPnlPercent !== null ? (
                          <span className={signal.realizedPnlPercent >= 0 ? 'text-green-400' : 'text-red-400'}>
                            {signal.realizedPnlPercent >= 0 ? '+' : ''}{signal.realizedPnlPercent.toFixed(1)}%
                          </span>
                        ) : '-'}
                      </td>
                      <td className="px-4 py-3">
                        {signal.missedPnlPercent !== null && signal.missedPnlPercent > 0 ? (
                          <span className={`${
                            signal.missedPnlPercent >= 100 ? 'text-red-400 font-bold' :
                            signal.missedPnlPercent >= 50 ? 'text-orange-400' : 'text-yellow-400'
                          }`}>
                            {signal.missedPnlPercent.toFixed(1)}%
                          </span>
                        ) : '-'}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-1 rounded text-xs ${
                          signal.status === 'active' ? 'bg-green-500/20 text-green-400' :
                          signal.status === 'closed' ? 'bg-gray-500/20 text-gray-400' :
                          'bg-yellow-500/20 text-yellow-400'
                        }`}>
                          {signal.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {signalsTable.length === 0 && (
              <div className="text-center py-12 text-gray-400">
                No signals with performance data found
              </div>
            )}
          </div>
        )}

        {/* Missed Gains Analysis */}
        {activeTab === 'missed' && (
          <div className="p-6">
            <h3 className="text-lg font-bold text-white mb-6">Missed Gains Analysis</h3>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
              <div className="bg-gray-900/50 rounded-lg p-4 border border-orange-500/30">
                <div className="text-gray-400 text-xs mb-1">Average Missed</div>
                <div className="text-3xl font-bold text-orange-400">{missedGains.avgMissed.toFixed(1)}%</div>
              </div>
              <div className="bg-gray-900/50 rounded-lg p-4 border border-red-500/30">
                <div className="text-gray-400 text-xs mb-1">Max Missed</div>
                <div className="text-3xl font-bold text-red-400">{missedGains.maxMissed.toFixed(0)}%</div>
              </div>
              <div className="bg-gray-900/50 rounded-lg p-4 border border-yellow-500/30">
                <div className="text-gray-400 text-xs mb-1">Missed 50%+</div>
                <div className="text-3xl font-bold text-yellow-400">{missedGains.signalsWithMissed50Plus}</div>
              </div>
              <div className="bg-gray-900/50 rounded-lg p-4 border border-red-500/30">
                <div className="text-gray-400 text-xs mb-1">Missed 100%+</div>
                <div className="text-3xl font-bold text-red-400">{missedGains.signalsWithMissed100Plus}</div>
              </div>
            </div>

            {/* Milestone Performance */}
            <h4 className="text-md font-semibold text-white mb-4">Average P&L by Time</h4>
            <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-9 gap-3">
              {Object.entries(analytics.byMilestone || {}).map(([milestone, data]) => (
                <div key={milestone} className="bg-gray-900/50 rounded-lg p-3 text-center">
                  <div className="text-gray-400 text-xs mb-1">{milestone}</div>
                  <div className={`text-lg font-bold ${data.avgPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {data.avgPnl >= 0 ? '+' : ''}{data.avgPnl.toFixed(1)}%
                  </div>
                  <div className="text-xs text-gray-500">{data.count} signals</div>
                </div>
              ))}
            </div>

            {Object.keys(analytics.byMilestone || {}).length === 0 && (
              <div className="text-center py-8 text-gray-400">
                No milestone data available yet
              </div>
            )}

            {/* Top Missed Signals */}
            <h4 className="text-md font-semibold text-white mt-8 mb-4">Top Missed Opportunities</h4>
            <div className="space-y-3">
              {signalsTable
                .filter(s => s.missedPnlPercent !== null && s.missedPnlPercent > 20)
                .sort((a, b) => (b.missedPnlPercent || 0) - (a.missedPnlPercent || 0))
                .slice(0, 5)
                .map(signal => (
                  <div key={signal.id} className="bg-gray-900/50 rounded-lg p-4 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <a
                        href={`https://birdeye.so/token/${signal.tokenMint}?chain=solana`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-white hover:text-blue-400"
                      >
                        {signal.tokenSymbol}
                      </a>
                      <span className="text-xs text-gray-400">
                        {SIGNAL_TYPE_CONFIG[signal.signalType]?.icon} {signal.signalType}
                      </span>
                    </div>
                    <div className="flex items-center gap-6">
                      <div className="text-right">
                        <div className="text-xs text-gray-400">Max</div>
                        <div className="text-green-400 font-medium">+{signal.maxPnlPercent?.toFixed(0)}%</div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs text-gray-400">Realized</div>
                        <div className={signal.realizedPnlPercent && signal.realizedPnlPercent >= 0 ? 'text-green-400' : 'text-red-400'}>
                          {signal.realizedPnlPercent ? `${signal.realizedPnlPercent >= 0 ? '+' : ''}${signal.realizedPnlPercent.toFixed(0)}%` : '-'}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs text-gray-400">Missed</div>
                        <div className="text-orange-400 font-bold">{signal.missedPnlPercent?.toFixed(0)}%</div>
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* AI Accuracy */}
        {activeTab === 'ai' && (
          <div className="p-6">
            <h3 className="text-lg font-bold text-white mb-6">AI Decision Accuracy</h3>

            {aiTotalDecisions > 0 ? (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
                  <div className="bg-gray-900/50 rounded-lg p-4 border border-blue-500/30">
                    <div className="text-gray-400 text-xs mb-1">Overall Accuracy</div>
                    <div className={`text-3xl font-bold ${aiAccuracyPercent >= 60 ? 'text-green-400' : 'text-orange-400'}`}>
                      {aiAccuracyPercent.toFixed(0)}%
                    </div>
                    <div className="text-xs text-gray-500">{aiTotalDecisions} decisions</div>
                  </div>
                  <div className="bg-gray-900/50 rounded-lg p-4 border border-green-500/30">
                    <div className="text-gray-400 text-xs mb-1">BUY Correct</div>
                    <div className="text-3xl font-bold text-green-400">{aiAccuracy.buyCorrect}</div>
                    <div className="text-xs text-gray-500">
                      {aiAccuracy.buyCorrect + aiAccuracy.buyWrong > 0
                        ? `${((aiAccuracy.buyCorrect / (aiAccuracy.buyCorrect + aiAccuracy.buyWrong)) * 100).toFixed(0)}% accuracy`
                        : 'No data'}
                    </div>
                  </div>
                  <div className="bg-gray-900/50 rounded-lg p-4 border border-red-500/30">
                    <div className="text-gray-400 text-xs mb-1">BUY Wrong</div>
                    <div className="text-3xl font-bold text-red-400">{aiAccuracy.buyWrong}</div>
                  </div>
                  <div className="bg-gray-900/50 rounded-lg p-4 border border-gray-500/30">
                    <div className="text-gray-400 text-xs mb-1">SKIP Correct</div>
                    <div className="text-3xl font-bold text-gray-400">{aiAccuracy.skipCorrect}</div>
                  </div>
                </div>

                {/* Visual Bar */}
                <div className="bg-gray-900/50 rounded-lg p-4">
                  <div className="text-sm text-gray-400 mb-2">Decision Distribution</div>
                  <div className="flex h-8 rounded-lg overflow-hidden">
                    {aiAccuracy.buyCorrect > 0 && (
                      <div
                        className="bg-green-500 flex items-center justify-center text-xs text-white font-medium"
                        style={{ width: `${(aiAccuracy.buyCorrect / aiTotalDecisions) * 100}%` }}
                      >
                        {aiAccuracy.buyCorrect > 0 ? 'BUY OK' : ''}
                      </div>
                    )}
                    {aiAccuracy.buyWrong > 0 && (
                      <div
                        className="bg-red-500 flex items-center justify-center text-xs text-white font-medium"
                        style={{ width: `${(aiAccuracy.buyWrong / aiTotalDecisions) * 100}%` }}
                      >
                        {aiAccuracy.buyWrong > 0 ? 'BUY BAD' : ''}
                      </div>
                    )}
                    {aiAccuracy.skipCorrect > 0 && (
                      <div
                        className="bg-gray-500 flex items-center justify-center text-xs text-white font-medium"
                        style={{ width: `${(aiAccuracy.skipCorrect / aiTotalDecisions) * 100}%` }}
                      >
                        {aiAccuracy.skipCorrect > 0 ? 'SKIP OK' : ''}
                      </div>
                    )}
                    {aiAccuracy.skipWrong > 0 && (
                      <div
                        className="bg-orange-500 flex items-center justify-center text-xs text-white font-medium"
                        style={{ width: `${(aiAccuracy.skipWrong / aiTotalDecisions) * 100}%` }}
                      >
                        {aiAccuracy.skipWrong > 0 ? 'SKIP BAD' : ''}
                      </div>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="text-center py-12 text-gray-400">
                No AI decisions with outcomes available yet.
                <p className="text-sm mt-2">AI accuracy is calculated once signals are closed.</p>
              </div>
            )}
          </div>
        )}

        {/* Win Rate by Type */}
        {activeTab === 'types' && (
          <div className="p-6">
            <h3 className="text-lg font-bold text-white mb-6">Performance by Signal Type</h3>

            {Object.keys(winRateByType).length > 0 ? (
              <div className="space-y-4">
                {Object.entries(winRateByType)
                  .sort((a, b) => b[1].total - a[1].total)
                  .map(([type, stats]) => {
                    const typeConfig = SIGNAL_TYPE_CONFIG[type] || {
                      icon: '📊', label: type, color: 'bg-gray-500/20 text-gray-400'
                    };
                    const winRate = stats.total > 0 ? (stats.wins / stats.total) * 100 : 0;

                    return (
                      <div key={type} className="bg-gray-900/50 rounded-lg p-4">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <span className={`px-3 py-1 rounded ${typeConfig.color}`}>
                              {typeConfig.icon} {typeConfig.label}
                            </span>
                            <span className="text-gray-400 text-sm">{stats.total} signals</span>
                          </div>
                          <div className="flex items-center gap-6">
                            <div className="text-right">
                              <div className="text-xs text-gray-400">Win Rate</div>
                              <div className={`font-bold ${winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                                {winRate.toFixed(0)}%
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="text-xs text-gray-400">Avg P&L</div>
                              <div className={`font-bold ${stats.avgPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                {stats.avgPnl >= 0 ? '+' : ''}{stats.avgPnl.toFixed(1)}%
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="text-xs text-gray-400">Avg Missed</div>
                              <div className="font-bold text-orange-400">
                                {stats.avgMissed.toFixed(1)}%
                              </div>
                            </div>
                          </div>
                        </div>
                        {/* Win rate bar */}
                        <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                          <div
                            className={`h-full ${winRate >= 50 ? 'bg-green-500' : 'bg-red-500'}`}
                            style={{ width: `${winRate}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
              </div>
            ) : (
              <div className="text-center py-12 text-gray-400">
                No closed signals to analyze yet.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
