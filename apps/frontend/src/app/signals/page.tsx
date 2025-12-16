'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { fetchSignals, fetchSignalsSummary, fetchSignalTypes, evaluateSignalWithAI, fetchAIPerformance } from '@/lib/api';
import { formatNumber, formatPercent, formatDate } from '@/lib/utils';
import Spinner from '@/components/Spinner';

// Signal type configuration with icons and colors
const SIGNAL_CONFIG: Record<string, { icon: string; color: string; bgColor: string }> = {
  'consensus': { icon: '🤝', color: 'text-blue-400', bgColor: 'bg-blue-500/20' },
  'whale-entry': { icon: '🐋', color: 'text-purple-400', bgColor: 'bg-purple-500/20' },
  'early-sniper': { icon: '🎯', color: 'text-yellow-400', bgColor: 'bg-yellow-500/20' },
  'momentum': { icon: '📈', color: 'text-green-400', bgColor: 'bg-green-500/20' },
  're-entry': { icon: '🔄', color: 'text-cyan-400', bgColor: 'bg-cyan-500/20' },
  'hot-token': { icon: '🔥', color: 'text-orange-400', bgColor: 'bg-orange-500/20' },
  'accumulation': { icon: '📦', color: 'text-indigo-400', bgColor: 'bg-indigo-500/20' },
  'exit-warning': { icon: '⚠️', color: 'text-red-400', bgColor: 'bg-red-500/20' },
  'smart-copy': { icon: '📋', color: 'text-gray-400', bgColor: 'bg-gray-500/20' },
};

const STRENGTH_COLORS: Record<string, string> = {
  'strong': 'text-green-400 bg-green-500/20',
  'medium': 'text-yellow-400 bg-yellow-500/20',
  'weak': 'text-gray-400 bg-gray-500/20',
};

const RISK_COLORS: Record<string, string> = {
  'low': 'text-green-400',
  'medium': 'text-yellow-400',
  'high': 'text-red-400',
};

export default function SignalsPage() {
  const [signals, setSignals] = useState<any[]>([]);
  const [signalTypes, setSignalTypes] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [aiPerformance, setAiPerformance] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<'active' | 'executed' | 'expired' | null>('active');
  const [evaluatingId, setEvaluatingId] = useState<string | null>(null);
  const [aiResults, setAiResults] = useState<Record<string, any>>({});

  useEffect(() => {
    loadData();
  }, [selectedType, selectedStatus]);

  async function loadData() {
    setLoading(true);
    try {
      const [signalsData, typesData, summaryData, perfData] = await Promise.all([
        fetchSignals({ 
          model: selectedType || undefined, 
          status: selectedStatus || undefined,
          limit: 100 
        }),
        fetchSignalTypes(),
        fetchSignalsSummary(),
        fetchAIPerformance().catch(() => null),
      ]);
      
      setSignals(signalsData.signals || []);
      setSignalTypes(typesData.types || []);
      setSummary(summaryData.summary || null);
      setAiPerformance(perfData?.performance || null);
    } catch (error) {
      console.error('Error loading signals:', error);
      setSignals([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleEvaluateWithAI(signalId: string) {
    setEvaluatingId(signalId);
    try {
      const result = await evaluateSignalWithAI(signalId);
      if (result.evaluations && result.evaluations.length > 0) {
        setAiResults(prev => ({
          ...prev,
          [signalId]: result.evaluations[0].decision,
        }));
      }
    } catch (error: any) {
      console.error('Error evaluating signal:', error);
      alert(`Error: ${error.message}`);
    } finally {
      setEvaluatingId(null);
    }
  }

  function getSignalConfig(signal: any) {
    const signalType = signal.meta?.signalType || signal.model || 'consensus';
    return SIGNAL_CONFIG[signalType] || SIGNAL_CONFIG['consensus'];
  }

  function getSignalTypeName(signal: any) {
    const signalType = signal.meta?.signalType || signal.model || 'consensus';
    const typeInfo = signalTypes.find(t => t.id === signalType);
    return typeInfo?.name || signalType;
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">📊 Trading Signals</h1>
          <p className="text-gray-400">
            AI-powered signály z analýzy smart wallets
          </p>
        </div>
        <Link 
          href="/" 
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-white transition-colors"
        >
          ← Back
        </Link>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700">
            <div className="text-gray-400 text-sm mb-1">Active Signals</div>
            <div className="text-2xl font-bold text-white">{summary.total || 0}</div>
          </div>
          <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700">
            <div className="text-gray-400 text-sm mb-1">Strong</div>
            <div className="text-2xl font-bold text-green-400">{summary.byStrength?.strong || 0}</div>
          </div>
          <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700">
            <div className="text-gray-400 text-sm mb-1">Medium</div>
            <div className="text-2xl font-bold text-yellow-400">{summary.byStrength?.medium || 0}</div>
          </div>
          <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700">
            <div className="text-gray-400 text-sm mb-1">Signal Types</div>
            <div className="text-2xl font-bold text-blue-400">{Object.keys(summary.byType || {}).length}</div>
          </div>
        </div>
      )}

      {/* AI Performance (if available) */}
      {aiPerformance && aiPerformance.totalDecisions > 0 && (
        <div className="bg-gradient-to-r from-purple-900/30 to-blue-900/30 rounded-xl p-6 border border-purple-500/30 mb-8">
          <h2 className="text-xl font-bold text-white mb-4">🤖 AI Decision Engine</h2>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div>
              <div className="text-gray-400 text-sm">Total Decisions</div>
              <div className="text-xl font-bold text-white">{aiPerformance.totalDecisions}</div>
            </div>
            <div>
              <div className="text-gray-400 text-sm">Buy Signals</div>
              <div className="text-xl font-bold text-green-400">{aiPerformance.buyDecisions}</div>
            </div>
            <div>
              <div className="text-gray-400 text-sm">Skipped</div>
              <div className="text-xl font-bold text-gray-400">{aiPerformance.skipDecisions}</div>
            </div>
            <div>
              <div className="text-gray-400 text-sm">Avg Confidence</div>
              <div className="text-xl font-bold text-blue-400">{(aiPerformance.avgConfidence || 0).toFixed(0)}%</div>
            </div>
            <div>
              <div className="text-gray-400 text-sm">Avg Latency</div>
              <div className="text-xl font-bold text-purple-400">{(aiPerformance.avgLatencyMs || 0).toFixed(0)}ms</div>
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-4 mb-6">
        {/* Status Filter */}
        <div className="flex gap-2">
          {(['active', 'executed', 'expired'] as const).map(status => (
            <button
              key={status}
              onClick={() => setSelectedStatus(selectedStatus === status ? null : status)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                selectedStatus === status
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </button>
          ))}
        </div>

        {/* Type Filter */}
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setSelectedType(null)}
            className={`px-3 py-2 rounded-lg text-sm font-medium transition-all ${
              selectedType === null
                ? 'bg-purple-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            All Types
          </button>
          {signalTypes.slice(0, 6).map(type => {
            const config = SIGNAL_CONFIG[type.id] || SIGNAL_CONFIG['consensus'];
            return (
              <button
                key={type.id}
                onClick={() => setSelectedType(selectedType === type.id ? null : type.id)}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                  selectedType === type.id
                    ? `${config.bgColor} ${config.color} border border-current`
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                {config.icon} {type.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* Signals List */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner label="Loading signals..." />
        </div>
      ) : signals.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <div className="text-4xl mb-4">📭</div>
          <div>No signals found</div>
          <div className="text-sm mt-2">Signály se generují automaticky při nových trades</div>
        </div>
      ) : (
        <div className="space-y-4">
          {signals.map(signal => {
            const config = getSignalConfig(signal);
            const strength = signal.meta?.strength || 'medium';
            const aiResult = aiResults[signal.id];
            
            return (
              <div 
                key={signal.id}
                className={`bg-gray-800/50 rounded-xl p-5 border border-gray-700 hover:border-gray-600 transition-all ${
                  signal.status !== 'active' ? 'opacity-60' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  {/* Left: Signal Info */}
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      {/* Signal Type Badge */}
                      <span className={`text-2xl`}>{config.icon}</span>
                      <span className={`px-3 py-1 rounded-full text-sm font-medium ${config.bgColor} ${config.color}`}>
                        {getSignalTypeName(signal)}
                      </span>
                      
                      {/* Strength Badge */}
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${STRENGTH_COLORS[strength]}`}>
                        {strength.toUpperCase()}
                      </span>
                      
                      {/* Risk Level */}
                      {signal.riskLevel && (
                        <span className={`text-xs ${RISK_COLORS[signal.riskLevel]}`}>
                          Risk: {signal.riskLevel}
                        </span>
                      )}
                      
                      {/* Status */}
                      <span className={`px-2 py-0.5 rounded text-xs ${
                        signal.status === 'active' ? 'bg-green-500/20 text-green-400' :
                        signal.status === 'executed' ? 'bg-blue-500/20 text-blue-400' :
                        'bg-gray-500/20 text-gray-400'
                      }`}>
                        {signal.status}
                      </span>
                    </div>
                    
                    {/* Token Info */}
                    <div className="flex items-center gap-4 mb-2">
                      <span className="text-white font-semibold">
                        {signal.token?.symbol || 'Unknown Token'}
                      </span>
                      <span className="text-gray-400 text-sm">
                        {signal.token?.mintAddress?.substring(0, 8)}...
                      </span>
                      {signal.type === 'buy' ? (
                        <span className="text-green-400 text-sm">BUY</span>
                      ) : (
                        <span className="text-red-400 text-sm">SELL</span>
                      )}
                    </div>
                    
                    {/* Reasoning */}
                    <p className="text-gray-300 text-sm mb-3">
                      {signal.reasoning || 'No reasoning provided'}
                    </p>
                    
                    {/* Meta Info */}
                    <div className="flex flex-wrap gap-4 text-xs text-gray-400">
                      <span>Score: <span className="text-white">{signal.qualityScore?.toFixed(0) || '-'}</span></span>
                      {signal.meta?.suggestedPositionPercent && (
                        <span>Position: <span className="text-white">{signal.meta.suggestedPositionPercent}%</span></span>
                      )}
                      {signal.wallet && (
                        <span>
                          Wallet: 
                          <Link 
                            href={`/wallet/${signal.wallet.address}`}
                            className="text-blue-400 hover:underline ml-1"
                          >
                            {signal.wallet.label || signal.wallet.address?.substring(0, 8)}...
                          </Link>
                          <span className="text-gray-500 ml-1">(Score: {signal.wallet.score?.toFixed(0)})</span>
                        </span>
                      )}
                      <span>{formatDate(signal.createdAt)}</span>
                    </div>
                  </div>
                  
                  {/* Right: Actions & AI Result */}
                  <div className="flex flex-col items-end gap-2">
                    {/* AI Evaluation Button */}
                    {signal.status === 'active' && !aiResult && (
                      <button
                        onClick={() => handleEvaluateWithAI(signal.id)}
                        disabled={evaluatingId === signal.id}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                          evaluatingId === signal.id
                            ? 'bg-gray-600 text-gray-400 cursor-wait'
                            : 'bg-purple-600 hover:bg-purple-500 text-white'
                        }`}
                      >
                        {evaluatingId === signal.id ? '🤖 Analyzing...' : '🤖 AI Evaluate'}
                      </button>
                    )}
                    
                    {/* AI Result */}
                    {aiResult && (
                      <div className={`p-3 rounded-lg ${
                        aiResult.decision === 'buy' ? 'bg-green-500/20 border border-green-500/30' :
                        aiResult.decision === 'skip' ? 'bg-gray-500/20 border border-gray-500/30' :
                        'bg-red-500/20 border border-red-500/30'
                      }`}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-lg">
                            {aiResult.decision === 'buy' ? '✅' : aiResult.decision === 'skip' ? '⏭️' : '❌'}
                          </span>
                          <span className={`font-bold ${
                            aiResult.decision === 'buy' ? 'text-green-400' :
                            aiResult.decision === 'skip' ? 'text-gray-400' : 'text-red-400'
                          }`}>
                            {aiResult.decision.toUpperCase()}
                          </span>
                          <span className="text-gray-400 text-sm">
                            ({aiResult.confidence}% confident)
                          </span>
                        </div>
                        <p className="text-xs text-gray-300 max-w-xs">
                          {aiResult.reasoning}
                        </p>
                        {aiResult.decision === 'buy' && (
                          <div className="mt-2 text-xs text-gray-400 space-y-1">
                            <div>Position: {aiResult.suggestedPositionPercent}%</div>
                            <div>SL: {aiResult.stopLossPercent}% | TP: {aiResult.takeProfitPercent}%</div>
                            <div>Risk Score: {aiResult.riskScore}/10</div>
                          </div>
                        )}
                      </div>
                    )}
                    
                    {/* Solscan Link */}
                    {signal.token?.mintAddress && (
                      <a
                        href={`https://solscan.io/token/${signal.token.mintAddress}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-400 hover:underline"
                      >
                        View on Solscan →
                      </a>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Signal Types Legend */}
      <div className="mt-12 bg-gray-800/30 rounded-xl p-6 border border-gray-700">
        <h3 className="text-lg font-bold text-white mb-4">📚 Signal Types Reference</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {signalTypes.map(type => {
            const config = SIGNAL_CONFIG[type.id] || SIGNAL_CONFIG['consensus'];
            return (
              <div key={type.id} className="flex items-start gap-3">
                <span className="text-2xl">{config.icon}</span>
                <div>
                  <div className={`font-medium ${config.color}`}>{type.name}</div>
                  <div className="text-gray-400 text-sm">{type.description}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

