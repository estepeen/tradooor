'use client';

import Link from 'next/link';

export default function PaperTradingPage() {
  return (
    <div className="min-h-screen bg-background p-8">
      <div className="container mx-auto space-y-8">
        <div>
          <h1 className="text-3xl font-bold mb-2">Paper trading</h1>
          <p className="text-muted-foreground max-w-2xl">
            Sandbox for testing our strategies without risking real funds. Jakmile bude bot a
            datová vrstva stabilní, přidáme sem AI decision layer a simulaci obchodů na základě
            historických i realtime dat.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          <div className="border border-dashed border-border rounded-lg p-6 flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Status</h2>
            <p className="text-sm text-muted-foreground">
              Paper trading zatím není aktivní. Používáme tuto stránku jako přípravu pro budoucí
              simulace a AI řízení strategií.
            </p>
          </div>

          <div className="border border-dashed border-border rounded-lg p-6 flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Plán</h2>
            <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1">
              <li>Stabilizovat bota a výpočet metrik pro smart wallets.</li>
              <li>Navrhnout AI decision layer nad našimi statistikami a PnL daty.</li>
              <li>Spustit plně simulované paper trading portfolio.</li>
            </ul>
          </div>

          <div className="border border-dashed border-border rounded-lg p-6 flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Další kroky</h2>
            <p className="text-sm text-muted-foreground">
              Jakmile bude systém připraven, přidáme zde konfiguraci strategií, výběr smart wallets
              a přehled výkonnosti simulovaného portfolia.
            </p>
            <Link
              href="/stats"
              className="mt-2 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Zpět na statistiky
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}


