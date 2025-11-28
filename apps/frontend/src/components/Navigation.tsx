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
    <nav className="fixed top-0 left-0 right-0 z-[9999] border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <Link
            href="/"
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
          >
            <img 
              src="/logo.svg" 
              alt="Tradooor" 
              className="h-10 w-auto"
            />
          </Link>
          <div className="flex items-center gap-4">
              <Link
                href="/"
                className={`px-4 py-2 rounded-md transition-colors ${
                  isActive('/') && !isActive('/wallets/add') && !isActive('/wallet/') && !isActive('/stats') && !isActive('/paper-trading')
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted'
                }`}
              >
                Wallets
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
              <Link
                href="/paper-trading"
                className={`px-4 py-2 rounded-md transition-colors ${
                  isActive('/paper-trading')
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted'
                }`}
              >
                Paper trading
              </Link>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/wallets/add"
              aria-label="Add wallet"
              className={`px-3 py-2 rounded-md transition-colors inline-flex items-center justify-center ${
                isActive('/wallets/add')
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-muted'
              }`}
            >
              {/* Simple wallet/plus icon */}
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="6" width="18" height="12" rx="2" ry="2" />
                <path d="M16 12h4" />
                <path d="M8 12h4" />
              </svg>
            </Link>
            <Notifications />
          </div>
        </div>
      </div>
    </nav>
  );
}

