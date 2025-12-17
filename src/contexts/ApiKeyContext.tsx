'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';

interface ApiKeyContextType {
  apiKey: string | null;
  setApiKey: (key: string | null) => void;
  isConfigured: boolean;
  clearApiKey: () => void;
}

const ApiKeyContext = createContext<ApiKeyContextType | undefined>(undefined);

const STORAGE_KEY = 'signal_api_key';

export function ApiKeyProvider({ children }: { children: ReactNode }) {
  const [apiKey, setApiKeyState] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  // Load from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      setApiKeyState(stored);
    }
    setIsInitialized(true);
  }, []);

  const setApiKey = useCallback((key: string | null) => {
    setApiKeyState(key);
    if (key) {
      localStorage.setItem(STORAGE_KEY, key);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  const clearApiKey = useCallback(() => {
    setApiKeyState(null);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  // Don't render children until we've checked localStorage
  if (!isInitialized) {
    return null;
  }

  return (
    <ApiKeyContext.Provider
      value={{
        apiKey,
        setApiKey,
        isConfigured: !!apiKey,
        clearApiKey,
      }}
    >
      {children}
    </ApiKeyContext.Provider>
  );
}

export function useApiKey() {
  const context = useContext(ApiKeyContext);
  if (context === undefined) {
    throw new Error('useApiKey must be used within an ApiKeyProvider');
  }
  return context;
}

/**
 * Helper to get headers with API key
 */
export function useAuthHeaders() {
  const { apiKey } = useApiKey();

  return useCallback(
    (additionalHeaders?: Record<string, string>): Record<string, string> => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...additionalHeaders,
      };

      if (apiKey) {
        headers['X-API-Key'] = apiKey;
      }

      return headers;
    },
    [apiKey]
  );
}
