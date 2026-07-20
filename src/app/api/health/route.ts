/**
 * Railway Healthcheck Endpoint
 *
 * GET /api/health
 *
 * Lightweight health check used by Railway's healthcheckPath.
 * Returns 200 immediately without touching the database or external services.
 * This route is explicitly listed as public in middleware.ts.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    {
      status: 'ok',
      service: 'signal',
      timestamp: new Date().toISOString(),
    },
    { status: 200 }
  );
}
