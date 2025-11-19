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
    <nav className="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-8">
            <Link
              href="/"
              className="text-xl font-bold hover:opacity-80 transition-opacity"
            >
              Tradooor
            </Link>
            <div className="flex items-center gap-4">
              <Link
                href="/wallets"
                className={`px-4 py-2 rounded-md transition-colors ${
                  isActive('/wallets')
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted'
                }`}
              >
                Wallets
              </Link>
              <Link
                href="/wallets/add"
                className={`px-4 py-2 rounded-md transition-colors ${
                  isActive('/wallets/add')
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted'
                }`}
              >
                Add Wallet
              </Link>
              <Link
                href="/stats"
                className={`px-4 py-2 rounded-md transition-colors ${
                  isActive('/stats')
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted'
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

