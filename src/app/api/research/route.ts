import { NextResponse } from 'next/server';

/**
 * v1 Research API - DEPRECATED
 *
 * This endpoint has been retired. Use /api/v2/enrich instead.
 */
export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error: 'This endpoint has been retired. Use /api/v2/enrich instead.',
    },
    { status: 410 }
  );
}

export async function GET() {
  return NextResponse.json(
    {
      success: false,
      error: 'This endpoint has been retired. Use /api/v2/enrich instead.',
    },
    { status: 410 }
  );
}
