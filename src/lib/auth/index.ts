/**
 * Authentication & Authorization Module (Placeholder)
 *
 * IMPORTANT: This module provides placeholder auth functionality.
 * Before production deployment, implement proper authentication:
 * - API key validation for machine-to-machine calls
 * - Session-based auth for UI access
 * - Role-based access control for sensitive actions
 *
 * Sensitive endpoints that MUST be protected:
 * - POST /api/v2/identity/reveal (email extraction)
 * - POST /api/v2/identity/confirm (identity confirmation)
 * - DELETE /api/v2/identity/confirm (identity rejection)
 * - POST /api/v2/enrich (enrichment triggers)
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import { headers } from 'next/headers';
import crypto from 'crypto';

/**
 * Auth context for request handlers
 */
export interface AuthContext {
  authenticated: boolean;
  userId?: string;
  userEmail?: string;
  roles?: string[];
  apiKeyId?: string;
}

/**
 * Auth requirement levels
 */
export type AuthLevel =
  | 'none' // Public endpoint
  | 'authenticated' // Any authenticated user
  | 'recruiter' // Recruiter role required
  | 'admin'; // Admin role required

/**
 * Check if auth is enforced in current environment
 */
function isAuthEnforced(): boolean {
  // Auth is enforced in production unless explicitly disabled
  const env = process.env.NODE_ENV;
  const authDisabled = process.env.DISABLE_AUTH === 'true';

  if (env === 'production' && !authDisabled) {
    return true;
  }

  // In development, auth is optional but can be enabled
  return process.env.ENFORCE_AUTH === 'true';
}

/**
 * Extract API key from request headers
 */
async function extractApiKey(): Promise<string | null> {
  try {
    const headersList = await headers();

    // Check Authorization header (Bearer token)
    const authHeader = headersList.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }

    // Check X-API-Key header
    const apiKey = headersList.get('x-api-key');
    if (apiKey) {
      return apiKey;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Generate a short, stable identifier for an API key
 * Uses first 8 chars of SHA-256 hash (never stores or logs the raw key)
 */
function hashApiKeyId(apiKey: string): string {
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
  return `key_${hash.slice(0, 8)}`;
}

/**
 * Validate API key
 * TODO: Replace with actual API key validation (database lookup, JWT verification, etc.)
 */
async function validateApiKey(apiKey: string): Promise<AuthContext | null> {
  // PLACEHOLDER: In production, validate against database or auth service
  // For now, check against environment variable for basic protection

  const validKeys = process.env.API_KEYS?.split(',').map((k) => k.trim()) || [];

  if (validKeys.includes(apiKey)) {
    return {
      authenticated: true,
      apiKeyId: hashApiKeyId(apiKey), // Unique per key, but doesn't expose raw key
      roles: ['recruiter'], // Default role for API key access
    };
  }

  return null;
}

/**
 * Get auth context for current request
 */
export async function getAuthContext(): Promise<AuthContext> {
  const apiKey = await extractApiKey();

  if (apiKey) {
    const context = await validateApiKey(apiKey);
    if (context) {
      return context;
    }
  }

  // No valid authentication found
  return { authenticated: false };
}

/**
 * Check if request is authorized for given level
 */
export async function checkAuth(
  level: AuthLevel
): Promise<{ authorized: true; context: AuthContext } | { authorized: false; error: string }> {
  // No auth required
  if (level === 'none') {
    return { authorized: true, context: { authenticated: false } };
  }

  // Check if auth is enforced
  if (!isAuthEnforced()) {
    // Auth not enforced - allow with warning
    console.warn(
      `[Auth] Auth not enforced but ${level} level requested. Enable ENFORCE_AUTH=true for production.`
    );
    return {
      authorized: true,
      context: {
        authenticated: false,
        roles: ['recruiter'], // Grant default role when auth not enforced
      },
    };
  }

  // Auth is enforced - validate
  const context = await getAuthContext();

  if (!context.authenticated) {
    return {
      authorized: false,
      error: 'Authentication required. Provide API key via Authorization header or X-API-Key.',
    };
  }

  // Check role requirements
  if (level === 'recruiter' && !context.roles?.includes('recruiter') && !context.roles?.includes('admin')) {
    return {
      authorized: false,
      error: 'Recruiter role required for this action.',
    };
  }

  if (level === 'admin' && !context.roles?.includes('admin')) {
    return {
      authorized: false,
      error: 'Admin role required for this action.',
    };
  }

  return { authorized: true, context };
}

/**
 * Auth middleware helper - returns error response if unauthorized
 */
export async function withAuth(
  level: AuthLevel
): Promise<{ authorized: true; context: AuthContext } | { authorized: false; response: Response }> {
  const result = await checkAuth(level);

  if (!result.authorized) {
    return {
      authorized: false,
      response: new Response(
        JSON.stringify({
          success: false,
          error: result.error,
        }),
        {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer',
          },
        }
      ),
    };
  }

  return { authorized: true, context: result.context };
}

/**
 * Get actor string for audit logging
 */
export function getActorString(context: AuthContext): string {
  if (!context.authenticated) {
    return 'anonymous';
  }

  if (context.userId) {
    return `recruiter:${context.userId}`;
  }

  if (context.apiKeyId) {
    return `api-key:${context.apiKeyId}`;
  }

  return 'authenticated';
}

export default {
  getAuthContext,
  checkAuth,
  withAuth,
  getActorString,
  isAuthEnforced,
};
