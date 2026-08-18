import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { GET as getLegacyImageProxy } from '@/app/api/proxy-image/route';
import { GET as getLegacyResearch, POST as postLegacyResearch } from '@/app/api/research/route';
import { GET as getLegacySearch, POST as postLegacySearch } from '@/app/api/search/route';
import { GET as getV2Review } from '@/app/api/v2/review/route';
import { GET as getV2Search, POST as postV2Search } from '@/app/api/v2/search/route';
import { GET as getV2Sessions } from '@/app/api/v2/sessions/route';
import {
  LEGACY_IMAGE_PROXY_RETIREMENT_BODY,
  LEGACY_V2_RETIREMENT_BODY,
  isLegacyBrowserPath,
} from '@/lib/legacy-retirement';
import { middleware } from '@/middleware';

describe('legacy Discover browser retirement', () => {
  it.each([
    '/',
    '/sign-in',
    '/sign-in/continue',
    '/sign-up',
    '/org-selector',
    '/search',
    '/review',
    '/sessions',
    '/enrich/candidate-1',
    '/admin/enrichment-diagnostics',
  ])('classifies %s as retired', (pathname) => {
    expect(isLegacyBrowserPath(pathname)).toBe(true);
  });

  it.each(['/api/health', '/api/health/providers', '/api/v3/jobs/job-1/results']) (
    'does not classify supported/internal path %s as a retired browser page',
    (pathname) => {
      expect(isLegacyBrowserPath(pathname)).toBe(false);
    }
  );

  it('returns an HTTP 410 browser response without a credential flow', () => {
    const response = middleware(new NextRequest('https://discover.example/search'));

    expect(response.status).toBe(410);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.body).not.toBeNull();
  });
});

describe('legacy Discover API tombstones', () => {
  const retiredHandlers: Array<[string, () => Promise<Response>]> = [
    ['GET /api/v2/search', getV2Search],
    ['POST /api/v2/search', postV2Search],
    ['GET /api/v2/review', getV2Review],
    ['GET /api/v2/sessions', getV2Sessions],
    ['GET /api/search', getLegacySearch],
    ['POST /api/search', postLegacySearch],
    ['GET /api/research', getLegacyResearch],
    ['POST /api/research', postLegacyResearch],
  ];

  it.each(retiredHandlers)('%s returns the stable side-effect-free retirement response', async (_name, handler) => {
    const response = await handler();

    expect(response.status).toBe(410);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual(LEGACY_V2_RETIREMENT_BODY);
  });

  it.each([
    'src/app/api/v2/search/route.ts',
    'src/app/api/v2/review/route.ts',
    'src/app/api/v2/sessions/route.ts',
  ])('%s imports no auth, database, cache, queue, or provider dependency', (path) => {
    const source = readFileSync(path, 'utf8');

    expect(source).not.toMatch(/prisma|redis|bull|queue|provider|withAuth|service-jwt/i);
    expect(source).toContain("@/lib/legacy-retirement");
  });

  it('GET /api/proxy-image returns a stable request-independent retirement response', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const response = await getLegacyImageProxy();

    expect(response.status).toBe(410);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual(LEGACY_IMAGE_PROXY_RETIREMENT_BODY);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('the image-proxy tombstone has no network, body, or configuration path', () => {
    const source = readFileSync('src/app/api/proxy-image/route.ts', 'utf8');

    expect(source).toContain('legacyImageProxyGoneResponse');
    expect(source).not.toMatch(
      /fetch|arrayBuffer|NextRequest|node:net|IMAGE_PROXY_ALLOWED_HOSTS|content-length|image\//i
    );
  });
});
