/**
 * Authentication & Authorization Module
 *
 * Uses Clerk for session-based authentication (browser sessions via cookies).
 *
 * Auth flow:
 * 1. Check Clerk session (userId + orgId) → tenantId = orgId
 * 2. Return unified auth context with tenantId for multi-tenant operations
 *
 * ⚠️  CRITICAL: Production Security Notes
 *
 * 1. ALL v2 route handlers MUST call withAuth() + requireTenantId()
 *    These are the enforcement points for authentication.
 *
 * Sensitive endpoints that MUST be protected:
 * - POST /api/v2/identity/reveal (email extraction)
 * - POST /api/v2/identity/confirm (identity confirmation)
 * - DELETE /api/v2/identity/confirm (identity rejection)
 * - POST /api/v2/enrich (enrichment triggers)
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import { auth } from '@clerk/nextjs/server';

/**
 * Auth context for request handlers
 */
export interface AuthContext {
  authenticated: boolean;
  userId?: string;
  userEmail?: string;
  tenantId?: string; // Clerk orgId - used for multi-tenancy
  orgRole?: string; // Role within the org
  roles?: string[];
  authMethod?: 'clerk' | 'none';
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
 * Get Clerk auth context
 */
async function getClerkAuthContext(): Promise<AuthContext | null> {
  try {
    const { userId, orgId, orgRole } = await auth();

    if (userId && orgId) {
      return {
        authenticated: true,
        userId,
        tenantId: orgId,
        orgRole: orgRole || undefined,
        roles: ['recruiter'], // All org members are recruiters for now
        authMethod: 'clerk',
      };
    }

    // User is signed in but no org selected
    if (userId && !orgId) {
      return {
        authenticated: true,
        userId,
        roles: [],
        authMethod: 'clerk',
        // No tenantId - will fail org-required checks
      };
    }

    return null;
  } catch {
    // Clerk auth not available (e.g., called outside request context)
    return null;
  }
}

/**
 * Get auth context for current request
 */
export async function getAuthContext(): Promise<AuthContext> {
  // Get Clerk auth (browser sessions)
  const clerkContext = await getClerkAuthContext();
  if (clerkContext?.authenticated) {
    return clerkContext;
  }

  // No valid authentication found
  return { authenticated: false, authMethod: 'none' };
}

/**
 * Check options for auth
 */
export interface CheckAuthOptions {
  /** Require organization/tenant to be set */
  requireOrg?: boolean;
}

/**
 * Check if request is authorized for given level
 */
export async function checkAuth(
  level: AuthLevel,
  options: CheckAuthOptions = {}
): Promise<{ authorized: true; context: AuthContext } | { authorized: false; error: string }> {
  const { requireOrg = true } = options; // Default: require org for protected endpoints

  // No auth required
  if (level === 'none') {
    return { authorized: true, context: { authenticated: false, authMethod: 'none' } };
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
        authMethod: 'none',
      },
    };
  }

  // Auth is enforced - validate
  const context = await getAuthContext();

  if (!context.authenticated) {
    return {
      authorized: false,
      error: 'Authentication required. Please sign in.',
    };
  }

  // Check org requirement (multi-tenancy)
  if (requireOrg && !context.tenantId) {
    return {
      authorized: false,
      error: 'Organization required. Please select or create an organization.',
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
  level: AuthLevel,
  options: CheckAuthOptions = {}
): Promise<{ authorized: true; context: AuthContext } | { authorized: false; response: Response }> {
  const result = await checkAuth(level, options);

  if (!result.authorized) {
    // Determine appropriate status code
    const status = result.error.includes('Organization required') ? 403 : 401;

    return {
      authorized: false,
      response: new Response(
        JSON.stringify({
          success: false,
          error: result.error,
        }),
        {
          status,
          headers: {
            'Content-Type': 'application/json',
            ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
          },
        }
      ),
    };
  }

  return { authorized: true, context: result.context };
}

/**
 * Get actor string for audit logging
 * Format: user:{id}[@{tenantId}]
 */
export function getActorString(context: AuthContext): string {
  if (!context.authenticated) {
    return 'anonymous';
  }

  let actor: string;

  if (context.userId) {
    actor = `user:${context.userId}`;
  } else {
    actor = 'authenticated';
  }

  // Append tenant if available
  if (context.tenantId) {
    actor += `@${context.tenantId}`;
  }

  return actor;
}

/**
 * Convenience function to get tenantId from auth context
 * Throws if not available (for use in tenant-scoped endpoints)
 */
export function requireTenantId(context: AuthContext): string {
  if (!context.tenantId) {
    throw new Error('Organization required. Please select or create an organization.');
  }
  return context.tenantId;
}

export default {
  getAuthContext,
  checkAuth,
  withAuth,
  getActorString,
  requireTenantId,
  isAuthEnforced,
};
