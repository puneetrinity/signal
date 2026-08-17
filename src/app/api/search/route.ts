import { legacyV2GoneResponse } from '@/lib/legacy-retirement';

/**
 * v1 Search API - DEPRECATED
 *
 * This endpoint has been retired with the standalone Discover browser product.
 */
export async function POST() {
  return legacyV2GoneResponse();
}

export async function GET() {
  return legacyV2GoneResponse();
}
