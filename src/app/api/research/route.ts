import { NextRequest, NextResponse } from 'next/server';
import {
  createResearchRecord,
  getCachedResearch,
} from '@/lib/cache/research-cache';
import { runResearchGraph } from '@/lib/research/runner';

function isV1ResearchDisabled(): boolean {
  return process.env.DISABLE_V1_SCRAPING === 'true' || process.env.USE_NEW_DISCOVERY === 'true';
}

function normalizeLinkedInProfileUrl(input: string): string | null {
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    const hostname = parsed.hostname.toLowerCase();
    if (!hostname.endsWith('linkedin.com')) return null;

    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (pathParts[0] !== 'in' || !pathParts[1]) return null;

    return `https://www.linkedin.com/in/${pathParts[1]}`;
  } catch {
    return null;
  }
}

/**
 * POST /api/research
 * Initiate a new research request for a person
 */
export async function POST(request: NextRequest) {
  try {
    if (isV1ResearchDisabled()) {
      return NextResponse.json(
        {
          success: false,
          error:
            'This v1 endpoint is deprecated/disabled (research graph uses scraping). Use v2 enrichment endpoints instead.',
        },
        { status: 410 }
      );
    }

    const body = await request.json();
    const { linkedinUrl, personName } = body;

    // Validation
    if (!linkedinUrl || typeof linkedinUrl !== 'string') {
      return NextResponse.json(
        { success: false, error: 'LinkedIn URL is required' },
        { status: 400 }
      );
    }

    const normalizedLinkedinUrl = normalizeLinkedInProfileUrl(linkedinUrl);
    if (!normalizedLinkedinUrl) {
      return NextResponse.json(
        { success: false, error: 'Invalid LinkedIn URL format' },
        { status: 400 }
      );
    }

    console.log('[Research API] Research request for:', normalizedLinkedinUrl);

    // Check if we have a fresh cached research report
    const cachedResearch = await getCachedResearch(normalizedLinkedinUrl);
    if (cachedResearch) {
      console.log('[Research API] Returning cached research:', cachedResearch.id);
      return NextResponse.json({
        success: true,
        researchId: cachedResearch.id,
        status: cachedResearch.status,
        cached: true,
        personName: cachedResearch.personName,
        report: cachedResearch.report,
        sources: cachedResearch.sources,
        createdAt: cachedResearch.createdAt,
        updatedAt: cachedResearch.updatedAt,
      });
    }

    // Determine person name
    let finalPersonName = personName;
    if (!finalPersonName) {
      // Extract from LinkedIn URL as fallback
      const idFromUrl = normalizedLinkedinUrl.split('/in/')[1]?.split('/')[0];
      finalPersonName = idFromUrl ? idFromUrl.replace(/-/g, ' ') : 'Unknown Person';
    }

    console.log('[Research API] Creating new research record for:', finalPersonName);

    // Create research record in database with 'pending' status
    const research = await createResearchRecord(normalizedLinkedinUrl, finalPersonName);

    console.log('[Research API] Created research record:', research.id);

    // Trigger async graph execution (don't wait for completion)
    runResearchGraph(research.id, normalizedLinkedinUrl, finalPersonName).catch((error) => {
      console.error('[Research API] Graph execution error:', error);
    });

    // Return research ID immediately
    return NextResponse.json({
      success: true,
      researchId: research.id,
      status: 'pending',
      personName: finalPersonName,
      linkedinUrl: normalizedLinkedinUrl,
      message: 'Research initiated. Use the researchId to check status.',
    });
  } catch (error) {
    console.error('[Research API] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to initiate research',
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/research?limit=20&offset=0&status=completed
 * List recent research reports with pagination
 */
export async function GET(request: NextRequest) {
  try {
    if (isV1ResearchDisabled()) {
      return NextResponse.json(
        {
          success: false,
          error:
            'This v1 endpoint is deprecated/disabled (returns research built from scraped data). Use v2 enrichment endpoints instead.',
        },
        { status: 410 }
      );
    }

    const searchParams = request.nextUrl.searchParams;
    const limit = parseInt(searchParams.get('limit') || '20', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);
    const status = searchParams.get('status') as 'pending' | 'processing' | 'completed' | 'failed' | null;

    // Validation
    if (limit < 1 || limit > 100) {
      return NextResponse.json(
        { success: false, error: 'Limit must be between 1 and 100' },
        { status: 400 }
      );
    }

    if (offset < 0) {
      return NextResponse.json(
        { success: false, error: 'Offset must be non-negative' },
        { status: 400 }
      );
    }

    if (status && !['pending', 'processing', 'completed', 'failed'].includes(status)) {
      return NextResponse.json(
        { success: false, error: 'Invalid status filter' },
        { status: 400 }
      );
    }

    const { listRecentResearch } = await import('@/lib/cache/research-cache');
    const researches = await listRecentResearch(limit, offset, status || undefined);

    return NextResponse.json({
      success: true,
      count: researches.length,
      limit,
      offset,
      researches: researches.map((r) => ({
        id: r.id,
        personName: r.personName,
        linkedinUrl: r.linkedinUrl,
        status: r.status,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        errorMessage: r.errorMessage,
      })),
    });
  } catch (error) {
    console.error('[Research API] List error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list research',
      },
      { status: 500 }
    );
  }
}
