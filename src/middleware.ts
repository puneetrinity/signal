import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  isLegacyBrowserPath,
  legacyBrowserGoneResponse,
} from '@/lib/legacy-retirement';

export function middleware(request: NextRequest): NextResponse {
  if (isLegacyBrowserPath(request.nextUrl.pathname)) {
    return legacyBrowserGoneResponse();
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/',
    '/sign-in/:path*',
    '/sign-up/:path*',
    '/org-selector/:path*',
    '/search/:path*',
    '/review/:path*',
    '/sessions/:path*',
    '/enrich/:path*',
    '/admin/enrichment-diagnostics/:path*',
  ],
};
