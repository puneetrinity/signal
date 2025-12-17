'use client';

import { ApiKeyProvider } from '@/contexts/ApiKeyContext';
import type { ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  return <ApiKeyProvider>{children}</ApiKeyProvider>;
}
