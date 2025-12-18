'use client';

import { ClerkProvider } from '@clerk/nextjs';
import { ApiKeyProvider } from '@/contexts/ApiKeyContext';
import type { ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider>
      <ApiKeyProvider>{children}</ApiKeyProvider>
    </ClerkProvider>
  );
}
