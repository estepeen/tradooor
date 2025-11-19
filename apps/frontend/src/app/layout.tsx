import type { Metadata } from 'next'
import { Inter, Pirata_One } from 'next/font/google'
import './globals.css'
import Navigation from '@/components/Navigation'

const inter = Inter({ subsets: ['latin'] })
const pirata_one = Pirata_One({ 
  subsets: ['latin'],
  weight: '400',
  variable: '--font-pirata-one',
})

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
      <body className={`${inter.className} ${pirata_one.variable}`}>
        <Navigation />
        {children}
      </body>
    </html>
  )
}

