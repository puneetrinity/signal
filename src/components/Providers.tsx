'use client';

import { ClerkProvider } from '@clerk/nextjs';
import { ApiKeyProvider } from '@/contexts/ApiKeyContext';
import type { ReactNode } from 'react';

/**
 * Check if Clerk is configured (publishable key available)
 * During build, this may not be set, so we provide a fallback
 */
function isClerkConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
}

export function Providers({ children }: { children: ReactNode }) {
  // During build or if Clerk is not configured, skip ClerkProvider
  // This allows static pages to build without Clerk keys
  if (!isClerkConfigured()) {
    return <ApiKeyProvider>{children}</ApiKeyProvider>;
  }

  return (
    <ClerkProvider>
      <ApiKeyProvider>{children}</ApiKeyProvider>
    </ClerkProvider>
  );
}
