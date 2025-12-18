import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

/**
 * Public routes that don't require authentication
 */
const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/health',
  // Note: /api/v2/search is NOT public - handled specially below
]);

/**
 * Routes that require authentication
 */
const isProtectedRoute = createRouteMatcher([
  '/search(.*)',
  '/enrich(.*)',
  '/previous(.*)',
  '/org-selector(.*)',
]);

/**
 * API routes that require authentication + org
 */
const isProtectedApiRoute = createRouteMatcher([
  '/api/v2/search(.*)',
  '/api/v2/enrich(.*)',
  '/api/v2/identity(.*)',
]);

/**
 * Check if request has API key authentication headers
 * API key requests bypass Clerk middleware and are validated in route handlers
 */
function hasApiKeyAuth(req: Request): boolean {
  const authHeader = req.headers.get('authorization');
  const apiKeyHeader = req.headers.get('x-api-key');
  return !!(authHeader?.startsWith('Bearer ') || apiKeyHeader);
}

export default clerkMiddleware(async (auth, req) => {
  const { userId, orgId } = await auth();
  const url = req.nextUrl;

  // API key requests bypass Clerk middleware - validated in route handlers via withAuth()
  // Route handlers will check API key validity and X-Tenant-Id header
  if (isProtectedApiRoute(req) && hasApiKeyAuth(req)) {
    return NextResponse.next();
  }

  // Special case: /api/v2/search GET without 'q' param is a public health check
  if (url.pathname === '/api/v2/search' && req.method === 'GET' && !url.searchParams.has('q')) {
    return NextResponse.next();
  }

  // Special case: /api/v2/enrich GET without 'candidateId' is a public health check
  if (url.pathname === '/api/v2/enrich' && req.method === 'GET' && !url.searchParams.has('candidateId')) {
    return NextResponse.next();
  }

  // Allow public routes
  if (isPublicRoute(req)) {
    // Sign-in/sign-up pages - allow through
    if (url.pathname.startsWith('/sign-in') || url.pathname.startsWith('/sign-up')) {
      return NextResponse.next();
    }
    // Home page - if signed in, redirect to search
    if (url.pathname === '/' && userId) {
      return NextResponse.redirect(new URL('/search', req.url));
    }
    return NextResponse.next();
  }

  // Protected API routes - require auth + org
  // This includes /api/v2/search (except health check handled above)
  if (isProtectedApiRoute(req)) {
    if (!userId) {
      return NextResponse.json(
        { success: false, error: 'Authentication required' },
        { status: 401 }
      );
    }
    if (!orgId) {
      return NextResponse.json(
        { success: false, error: 'Organization required. Please select or create an organization.' },
        { status: 403 }
      );
    }
  }

  // Protected UI routes - require auth
  if (isProtectedRoute(req)) {
    if (!userId) {
      const signInUrl = new URL('/sign-in', req.url);
      signInUrl.searchParams.set('redirect_url', url.pathname);
      return NextResponse.redirect(signInUrl);
    }

    // Require org for protected routes (except org-selector itself)
    if (!orgId && !url.pathname.startsWith('/org-selector')) {
      return NextResponse.redirect(new URL('/org-selector', req.url));
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    // Skip Next.js internals and static files
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
};
