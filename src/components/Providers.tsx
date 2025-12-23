'use client';

import { ClerkProvider } from '@clerk/nextjs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

/**
 * Check if Clerk is configured (publishable key available)
 * During build, this may not be set, so we provide a fallback
 */
function isClerkConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30 * 1000, // 30 seconds
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  const content = (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  // During build or if Clerk is not configured, skip ClerkProvider
  // This allows static pages to build without Clerk keys
  if (!isClerkConfigured()) {
    return content;
  }

  return <ClerkProvider>{content}</ClerkProvider>;
}
