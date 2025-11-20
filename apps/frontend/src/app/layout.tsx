import type { Metadata } from 'next'
import { Inter, Pirata_One } from 'next/font/google'
import './globals.css'
import Navigation from '@/components/Navigation'

// Using Inter as base font (similar to Stack Sans Text style)
// If you have a specific "Stack Sans Text" font file, we can use it via @font-face
const inter = Inter({ 
  subsets: ['latin'],
  variable: '--font-stack-sans',
})
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
      <body className={`${inter.variable} ${pirata_one.variable} font-sans`}>
        <Navigation />
        {children}
      </body>
    </html>
  )
}

