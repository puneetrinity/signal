/**
 * POST /api/v3/pdl/contact
 *
 * Stub — will proxy contact data from PDL. Not implemented yet.
 * Scope: pdl:contact
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyServiceJWT } from '@/lib/auth/service-jwt';
import { requireScope } from '@/lib/auth/service-scopes';

export async function POST(request: NextRequest) {
  const auth = await verifyServiceJWT(request);
  if (!auth.authorized) return auth.response;

  const scopeCheck = requireScope(auth.context, 'pdl:contact');
  if (!scopeCheck.authorized) return scopeCheck.response;

  return NextResponse.json({
    success: true,
    status: 'not_implemented',
    tenantId: auth.context.tenantId,
  });
}
