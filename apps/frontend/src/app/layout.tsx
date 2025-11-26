import type { Metadata } from 'next'
import './globals.css'
import Navigation from '@/components/Navigation'

export const metadata: Metadata = {
  title: 'Tradooor - Smart Wallet Analytics',
  description: 'Track and analyze smart wallets on Solana',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body className="font-sans">
        <Navigation />
        <div className="pt-16">
          {children}
        </div>
      </body>
    </html>
  )
}

