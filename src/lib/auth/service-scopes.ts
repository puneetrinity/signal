/**
 * Scope enforcement for v3 service auth.
 */

import type { ServiceAuthContext } from './service-jwt';

type ScopeResult =
  | { authorized: true }
  | { authorized: false; response: Response };

export function requireScope(
  context: ServiceAuthContext,
  scope: string,
): ScopeResult {
  if (context.scopes.includes(scope)) {
    return { authorized: true };
  }

  return {
    authorized: false,
    response: new Response(
      JSON.stringify({
        success: false,
        error: `Missing required scope: ${scope}`,
      }),
      {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      },
    ),
  };
}
