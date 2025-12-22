import { NextResponse } from 'next/server';

/**
 * v1 Search API - DEPRECATED
 *
 * This endpoint has been retired. Use /api/v2/search instead.
 */
export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error: 'This endpoint has been retired. Use /api/v2/search instead.',
    },
    { status: 410 }
  );
}

export async function GET() {
  return NextResponse.json(
    {
      success: false,
      error: 'This endpoint has been retired. Use /api/v2/search instead.',
    },
    { status: 410 }
  );
}
