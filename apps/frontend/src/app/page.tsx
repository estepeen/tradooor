'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    // Redirect to wallets page (homepage)
    router.replace('/wallets');
  }, [router]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
        <p className="text-muted-foreground">Redirecting to wallets...</p>
      </div>
    </div>
  );
}
