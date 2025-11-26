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
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              // Prevent browser extensions from setting window.ethereum if it's read-only
              if (typeof window !== 'undefined' && window.ethereum && Object.getOwnPropertyDescriptor(window, 'ethereum')?.configurable === false) {
                try {
                  Object.defineProperty(window, 'ethereum', {
                    value: window.ethereum,
                    writable: true,
                    configurable: true
                  });
                } catch (e) {
                  console.warn('Could not configure window.ethereum:', e);
                }
              }
            `,
          }}
        />
      </head>
      <body className="font-sans">
        <Navigation />
        <div className="pt-16">
          {children}
        </div>
      </body>
    </html>
  )
}

