'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function WalletsPage() {
  const router = useRouter();

  useEffect(() => {
    // Redirect to homepage (wallets are now on homepage)
    router.replace('/');
  }, [router]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="text-center">
        <p className="text-muted-foreground">Redirecting...</p>
      </div>
    </div>
  );
}
