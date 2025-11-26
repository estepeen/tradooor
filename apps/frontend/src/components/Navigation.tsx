'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Notifications from './Notifications';

export default function Navigation() {
  const pathname = usePathname();

  const isActive = (path: string) => {
    if (path === '/') {
      return pathname === '/';
    }
    return pathname?.startsWith(path);
  };

  return (
    <nav className="sticky top-0 z-50 border-b border-white/10 bg-black/50 backdrop-blur-xl supports-[backdrop-filter]:bg-black/20">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-8">
            <Link
              href="/"
              className="text-xl font-bold bg-gradient-to-r from-white to-white/60 bg-clip-text text-transparent hover:opacity-80 transition-opacity"
            >
              Tradooor
            </Link>
            <div className="flex items-center gap-1">
              <Link
                href="/"
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  isActive('/') && !isActive('/wallets/add') && !isActive('/wallet/') && !isActive('/stats')
                    ? 'bg-white/10 text-white shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
                }`}
              >
                Wallets
              </Link>
              <Link
                href="/wallets/add"
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  isActive('/wallets/add')
                    ? 'bg-white/10 text-white shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
                }`}
              >
                Add Wallet
              </Link>
              <Link
                href="/stats"
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  isActive('/stats')
                    ? 'bg-white/10 text-white shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
                }`}
              >
                Statistics
              </Link>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <Notifications />
          </div>
        </div>
      </div>
    </nav>
  );
}
