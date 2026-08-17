import { legacyV2GoneResponse } from '@/lib/legacy-retirement';

export const dynamic = 'force-dynamic';

export async function GET() {
  return legacyV2GoneResponse();
}

export async function POST() {
  return legacyV2GoneResponse();
}
