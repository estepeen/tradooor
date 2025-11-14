import Link from 'next/link'

export default function Home() {
  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-16">
        <div className="text-center">
          <h1 className="text-4xl font-bold mb-4">SolBot</h1>
          <p className="text-muted-foreground mb-8">
            Smart Wallet Tracking & Analytics Platform
          </p>
          <div className="flex gap-4 justify-center">
            <Link
              href="/wallets"
              className="inline-block px-6 py-3 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
            >
              View Smart Wallets
            </Link>
            <Link
              href="/wallets/add"
              className="inline-block px-6 py-3 border border-border rounded-md hover:bg-muted transition-colors"
            >
              Add Wallet
            </Link>
            <Link
              href="/stats"
              className="inline-block px-6 py-3 border border-border rounded-md hover:bg-muted transition-colors"
            >
              Global Statistics
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}

