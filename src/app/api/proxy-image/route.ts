import { legacyImageProxyGoneResponse } from '@/lib/legacy-retirement';

export const dynamic = 'force-dynamic';

export async function GET() {
  return legacyImageProxyGoneResponse();
}
