'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

export default function AddWalletPage() {
  const router = useRouter();
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [tags, setTags] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const tagsArray = tags
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);

      const response = await fetch(`${API_BASE_URL}/smart-wallets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          address: address.trim(),
          label: label.trim() || null,
          tags: tagsArray,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to add wallet');
      }

      const wallet = await response.json();
      setSuccess(true);
      
      // Redirect to wallet detail after 1 second
      setTimeout(() => {
        router.push(`/wallets/${wallet.id}`);
      }, 1000);
    } catch (err: any) {
      setError(err.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="container mx-auto max-w-2xl">
        <Link href="/wallets" className="text-primary hover:underline mb-4 inline-block">
          ← Back to Wallets
        </Link>

        <div className="border border-border rounded-lg p-6">
          <h1 className="text-2xl font-bold mb-4">Add Smart Wallet</h1>

          {error && (
            <div className="mb-4 p-3 bg-red-950/50 border border-red-500/50 text-red-400 rounded">
              {error}
            </div>
          )}

          {success && (
            <div className="mb-4 p-3 bg-green-950/50 border border-green-500/50 text-green-400 rounded">
              ✅ Wallet added successfully! Redirecting...
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="address" className="block text-sm font-medium mb-2">
                Wallet Address <span className="text-red-500">*</span>
              </label>
              <input
                id="address"
                type="text"
                required
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="e.g., 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
                className="w-full px-4 py-2 border border-border rounded-md bg-background font-mono text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Valid Solana wallet address
              </p>
            </div>

            <div>
              <label htmlFor="label" className="block text-sm font-medium mb-2">
                Label (optional)
              </label>
              <input
                id="label"
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g., My Trader, Call Channel X"
                className="w-full px-4 py-2 border border-border rounded-md bg-background"
              />
            </div>

            <div>
              <label htmlFor="tags" className="block text-sm font-medium mb-2">
                Tags (optional)
              </label>
              <input
                id="tags"
                type="text"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="e.g., degen, sniper, calls (comma-separated)"
                className="w-full px-4 py-2 border border-border rounded-md bg-background"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Comma-separated tags for categorization
              </p>
            </div>

            <div className="flex gap-4">
              <button
                type="submit"
                disabled={loading}
                className="px-6 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
              >
                {loading ? 'Adding...' : 'Add Wallet'}
              </button>
              <Link
                href="/wallets"
                className="px-6 py-2 border border-border rounded-md hover:bg-muted"
              >
                Cancel
              </Link>
            </div>
          </form>
        </div>

        <div className="mt-6 p-4 bg-muted rounded-lg">
          <h2 className="font-semibold mb-2">💡 Tip</h2>
          <p className="text-sm text-muted-foreground">
            Po přidání wallet můžeš spustit backfill historických transakcí:
          </p>
          <code className="block mt-2 p-2 bg-background rounded text-xs">
            pnpm --filter backend collector:backfill WALLET_ADDRESS 100
          </code>
        </div>
      </div>
    </div>
  );
}

