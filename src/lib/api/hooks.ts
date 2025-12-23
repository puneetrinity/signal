import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CandidateData,
  IdentityCandidateData,
  EnrichmentSessionSummary,
} from '@/types/linkedin';

// Query keys for cache management
export const queryKeys = {
  candidate: (id: string) => ['candidate', id] as const,
  reviewQueue: (filters?: { bridgeTier?: number }) =>
    ['reviewQueue', filters] as const,
  sessions: (filters?: { status?: string }) => ['sessions', filters] as const,
};

// Response types
interface CandidateResponse {
  success: boolean;
  candidate: CandidateData;
  identityCandidates: IdentityCandidateData[];
  sessions: EnrichmentSessionSummary[];
}

interface ReviewQueueResponse {
  success: boolean;
  items: IdentityCandidateData[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  stats: {
    tierCounts: {
      tier1: number;
      tier2: number;
      tier3: number;
      unknown: number;
    };
    totalUnconfirmed: number;
  };
}

interface SessionsResponse {
  success: boolean;
  items: EnrichmentSessionSummary[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  stats: {
    statusCounts: {
      pending: number;
      running: number;
      completed: number;
      failed: number;
    };
    totalSessions: number;
  };
}

interface ConfirmResponse {
  success: boolean;
  identity: IdentityCandidateData;
  summaryRegeneration?: {
    triggered: boolean;
    sessionId?: string;
  };
}

// Candidate data hook
export function useCandidate(candidateId: string) {
  return useQuery({
    queryKey: queryKeys.candidate(candidateId),
    queryFn: async (): Promise<CandidateResponse> => {
      const response = await fetch(`/api/v2/enrich?candidateId=${candidateId}`);
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to load candidate');
      }
      return response.json();
    },
    enabled: !!candidateId,
  });
}

// Review queue hook
export function useReviewQueue(filters?: { bridgeTier?: number }) {
  return useQuery({
    queryKey: queryKeys.reviewQueue(filters),
    queryFn: async (): Promise<ReviewQueueResponse> => {
      const params = new URLSearchParams();
      if (filters?.bridgeTier !== undefined) {
        params.set('bridgeTier', filters.bridgeTier.toString());
      }
      const response = await fetch(`/api/v2/review?${params.toString()}`);
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to load review queue');
      }
      return response.json();
    },
  });
}

// Sessions hook
export function useSessions(filters?: { status?: string }) {
  return useQuery({
    queryKey: queryKeys.sessions(filters),
    queryFn: async (): Promise<SessionsResponse> => {
      const params = new URLSearchParams();
      if (filters?.status) {
        params.set('status', filters.status);
      }
      params.set('includeTrace', 'true');
      const response = await fetch(`/api/v2/sessions?${params.toString()}`);
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to load sessions');
      }
      return response.json();
    },
  });
}

// Confirm identity mutation
export function useConfirmIdentity() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (identityCandidateId: string): Promise<ConfirmResponse> => {
      const response = await fetch('/api/v2/identity/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityCandidateId, method: 'recruiter_manual' }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to confirm identity');
      }
      return response.json();
    },
    onSuccess: (data, identityCandidateId) => {
      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: ['candidate'] });
      queryClient.invalidateQueries({ queryKey: ['reviewQueue'] });
    },
  });
}

// Reject identity mutation
export function useRejectIdentity() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (identityCandidateId: string): Promise<{ success: boolean }> => {
      const response = await fetch('/api/v2/identity/confirm', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityCandidateId }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to reject identity');
      }
      return response.json();
    },
    onSuccess: () => {
      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: ['candidate'] });
      queryClient.invalidateQueries({ queryKey: ['reviewQueue'] });
    },
  });
}

// Reveal email mutation
export function useRevealEmail() {
  return useMutation({
    mutationFn: async (identityCandidateId: string): Promise<{ email: string | null }> => {
      const response = await fetch('/api/v2/identity/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityCandidateId }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to reveal email');
      }
      return response.json();
    },
  });
}

// Start enrichment mutation
export function useStartEnrichment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (candidateId: string): Promise<{ sessionId: string }> => {
      const response = await fetch('/api/v2/enrich/async', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to start enrichment');
      }
      return response.json();
    },
    onSuccess: (data, candidateId) => {
      // Invalidate candidate query to refetch latest state
      queryClient.invalidateQueries({ queryKey: queryKeys.candidate(candidateId) });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}
