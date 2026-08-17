import { NextResponse } from 'next/server';

export const LEGACY_V2_RETIREMENT_BODY = {
  success: false,
  code: 'DISCOVER_V2_RETIRED',
  error: 'This legacy Discover browser API has been retired. Use the Ealana application.',
} as const;

const LEGACY_BROWSER_PREFIXES = [
  '/sign-in',
  '/sign-up',
  '/org-selector',
  '/search',
  '/review',
  '/sessions',
  '/enrich',
  '/admin/enrichment-diagnostics',
] as const;

export function isLegacyBrowserPath(pathname: string): boolean {
  if (pathname === '/') {
    return true;
  }

  return LEGACY_BROWSER_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

export function legacyV2GoneResponse(): NextResponse {
  return NextResponse.json(LEGACY_V2_RETIREMENT_BODY, {
    status: 410,
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}

export function legacyBrowserGoneResponse(): NextResponse {
  return new NextResponse(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Discover browser retired</title></head><body><main><h1>Discover browser retired</h1><p>Use the Ealana application.</p></main></body></html>',
    {
      status: 410,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8',
      },
    }
  );
}
