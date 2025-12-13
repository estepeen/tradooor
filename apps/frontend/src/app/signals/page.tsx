'use client';

import { useEffect, useState } from 'react';
import { fetchSignals } from '@/lib/api';
import { formatNumber, formatDate } from '@/lib/utils';

export default function SignalsPage() {
  const [signals, setSignals] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'buy' | 'sell'>('all');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadSignals();
    // Refresh každých 30 sekund
    const interval = setInterval(loadSignals, 30000);
    return () => clearInterval(interval);
  }, [filter]);

  async function loadSignals() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchSignals({
        type: filter === 'all' ? undefined : filter,
        limit: 100,
      });
      setSignals(data.signals || []);
    } catch (err: any) {
      console.error('Error loading signals:', err);
      setError(err.message || 'Failed to load signals');
    } finally {
      setLoading(false);
    }
  }

  const buySignals = signals.filter(s => s.type === 'buy');
  const sellSignals = signals.filter(s => s.type === 'sell');

  if (loading && signals.length === 0) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="text-center">Loading...</div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-4xl font-bold mb-4">Trading Signals</h1>
      <p className="text-muted-foreground mb-8">
        Automaticky generované signály na základě aktivit smart wallets. Signály jsou filtrovány podle kvality a rizika.
      </p>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-muted/30 rounded-lg p-4">
          <div className="text-sm text-muted-foreground">Total Signals</div>
          <div className="text-2xl font-bold">{signals.length}</div>
        </div>
        <div className="bg-muted/30 rounded-lg p-4">
          <div className="text-sm text-muted-foreground">Buy Signals</div>
          <div className="text-2xl font-bold text-green-400">{buySignals.length}</div>
        </div>
        <div className="bg-muted/30 rounded-lg p-4">
          <div className="text-sm text-muted-foreground">Sell Signals</div>
          <div className="text-2xl font-bold text-red-400">{sellSignals.length}</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-4 mb-6 border-b border-border">
        <button
          onClick={() => setFilter('all')}
          className={`pb-2 px-4 ${filter === 'all' ? 'border-b-2 border-primary' : ''}`}
        >
          All ({signals.length})
        </button>
        <button
          onClick={() => setFilter('buy')}
          className={`pb-2 px-4 ${filter === 'buy' ? 'border-b-2 border-primary' : ''}`}
        >
          Buy ({buySignals.length})
        </button>
        <button
          onClick={() => setFilter('sell')}
          className={`pb-2 px-4 ${filter === 'sell' ? 'border-b-2 border-primary' : ''}`}
        >
          Sell ({sellSignals.length})
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/50 rounded-lg p-4 mb-6 text-red-400">
          {error}
        </div>
      )}

      {/* Signals Table */}
      {signals.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          No active signals found. Signals are generated automatically when smart wallets make trades.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left p-4">Type</th>
                <th className="text-left p-4">Token</th>
                <th className="text-left p-4">Price</th>
                <th className="text-left p-4">Quality Score</th>
                <th className="text-left p-4">Risk</th>
                <th className="text-left p-4">Model</th>
                <th className="text-left p-4">Time</th>
                <th className="text-left p-4">Status</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((signal) => {
                const riskColor = 
                  signal.riskLevel === 'low' ? 'text-green-400' :
                  signal.riskLevel === 'medium' ? 'text-yellow-400' :
                  signal.riskLevel === 'high' ? 'text-red-400' : 'text-muted-foreground';

                return (
                  <tr key={signal.id} className="border-b border-border/50 hover:bg-muted/30">
                    <td className="p-4">
                      <span className={`px-2 py-1 rounded text-sm font-semibold ${
                        signal.type === 'buy' 
                          ? 'bg-green-500/20 text-green-400' 
                          : 'bg-red-500/20 text-red-400'
                      }`}>
                        {signal.type.toUpperCase()}
                      </span>
                    </td>
                    <td className="p-4 font-mono text-sm">
                      {signal.tokenId.substring(0, 16)}...
                    </td>
                    <td className="p-4">
                      ${formatNumber(signal.priceBasePerToken, 6)}
                    </td>
                    <td className="p-4">
                      {signal.qualityScore !== null ? (
                        <span className={signal.qualityScore >= 70 ? 'text-green-400' : signal.qualityScore >= 40 ? 'text-yellow-400' : 'text-red-400'}>
                          {signal.qualityScore.toFixed(1)}/100
                        </span>
                      ) : (
                        <span className="text-muted-foreground">N/A</span>
                      )}
                    </td>
                    <td className={`p-4 ${riskColor}`}>
                      {signal.riskLevel ? signal.riskLevel.toUpperCase() : 'N/A'}
                    </td>
                    <td className="p-4 text-sm text-muted-foreground">
                      {signal.model || 'N/A'}
                    </td>
                    <td className="p-4 text-sm text-muted-foreground">
                      {formatDate(signal.timestamp)}
                    </td>
                    <td className="p-4">
                      <span className={`px-2 py-1 rounded text-xs ${
                        signal.status === 'active' 
                          ? 'bg-green-500/20 text-green-400' 
                          : signal.status === 'executed'
                          ? 'bg-blue-500/20 text-blue-400'
                          : 'bg-muted text-muted-foreground'
                      }`}>
                        {signal.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Reasoning (expandable) */}
      {signals.length > 0 && (
        <div className="mt-8">
          <h2 className="text-2xl font-bold mb-4">Signal Details</h2>
          <div className="space-y-4">
            {signals.slice(0, 5).map((signal) => (
              signal.reasoning && (
                <div key={signal.id} className="bg-muted/30 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`px-2 py-1 rounded text-xs font-semibold ${
                      signal.type === 'buy' 
                        ? 'bg-green-500/20 text-green-400' 
                        : 'bg-red-500/20 text-red-400'
                    }`}>
                      {signal.type.toUpperCase()}
                    </span>
                    <span className="text-sm text-muted-foreground font-mono">
                      {signal.tokenId.substring(0, 16)}...
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">{signal.reasoning}</p>
                </div>
              )
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
