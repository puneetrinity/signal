/**
 * Enrichment Session SSE Stream
 *
 * GET /api/v2/enrich/session/stream?sessionId=xxx
 * - Server-Sent Events for real-time progress updates
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import { NextRequest } from 'next/server';
import { getQueueEvents, getEnrichmentSession } from '@/lib/enrichment/queue';
import { withAuth, requireTenantId } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

/**
 * GET /api/v2/enrich/session/stream
 *
 * SSE endpoint for real-time enrichment progress.
 *
 * Events:
 * - connected: Initial connection established
 * - progress: Job progress update
 * - completed: Job finished successfully
 * - failed: Job failed
 * - timeout: Long-running job timed out
 */
export async function GET(request: NextRequest) {
  // SSE streams can use cookie-based auth (Clerk session cookies are sent automatically)
  const authCheck = await withAuth('authenticated');
  if (!authCheck.authorized) {
    return new Response('Unauthorized', { status: 401 });
  }
  const tenantId = requireTenantId(authCheck.context);

  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');

  if (!sessionId) {
    return new Response('sessionId is required', { status: 400 });
  }

  // Verify session exists and belongs to tenant
  const sessionRecord = await prisma.enrichmentSession.findFirst({
    where: { id: sessionId, tenantId },
    select: { id: true, status: true, identitiesFound: true, finalConfidence: true },
  });

  if (!sessionRecord) {
    return new Response('Session not found', { status: 404 });
  }

  // If already completed, return immediately (use sessionRecord for status check)
  if (sessionRecord.status === 'completed' || sessionRecord.status === 'failed') {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const eventData = JSON.stringify({
          type: sessionRecord.status,
          sessionId,
          status: sessionRecord.status,
          identitiesFound: sessionRecord.identitiesFound,
          finalConfidence: sessionRecord.finalConfidence,
          timestamp: new Date().toISOString(),
        });
        controller.enqueue(encoder.encode(`event: ${sessionRecord.status}\ndata: ${eventData}\n\n`));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  // Set up SSE stream for active job
  const encoder = new TextEncoder();
  let isStreamClosed = false;

  const stream = new ReadableStream({
    async start(controller) {
      // Send initial connected event
      const connectedData = JSON.stringify({
        type: 'connected',
        sessionId,
        status: sessionRecord.status,
        timestamp: new Date().toISOString(),
      });
      controller.enqueue(encoder.encode(`event: connected\ndata: ${connectedData}\n\n`));

      // Get queue events
      const queueEvents = getQueueEvents();

      // Listen for progress updates
      const progressHandler = async ({ jobId, data }: { jobId: string; data: unknown }) => {
        if (jobId !== sessionId || isStreamClosed) return;

        try {
          const progressData = JSON.stringify({
            type: 'progress',
            sessionId,
            progress: data,
            timestamp: new Date().toISOString(),
          });
          controller.enqueue(encoder.encode(`event: progress\ndata: ${progressData}\n\n`));
        } catch {
          // Stream may be closed
        }
      };

      // Listen for completion
      const completedHandler = async ({
        jobId,
        returnvalue,
      }: {
        jobId: string;
        returnvalue: unknown;
      }) => {
        if (jobId !== sessionId || isStreamClosed) return;

        try {
          const completedData = JSON.stringify({
            type: 'completed',
            sessionId,
            result: returnvalue,
            timestamp: new Date().toISOString(),
          });
          controller.enqueue(encoder.encode(`event: completed\ndata: ${completedData}\n\n`));
          cleanup();
          controller.close();
        } catch {
          // Stream may be closed
        }
      };

      // Listen for failure
      const failedHandler = async ({
        jobId,
        failedReason,
      }: {
        jobId: string;
        failedReason: string;
      }) => {
        if (jobId !== sessionId || isStreamClosed) return;

        try {
          const failedData = JSON.stringify({
            type: 'failed',
            sessionId,
            error: failedReason,
            timestamp: new Date().toISOString(),
          });
          controller.enqueue(encoder.encode(`event: failed\ndata: ${failedData}\n\n`));
          cleanup();
          controller.close();
        } catch {
          // Stream may be closed
        }
      };

      // Register listeners
      queueEvents.on('progress', progressHandler);
      queueEvents.on('completed', completedHandler);
      queueEvents.on('failed', failedHandler);

      // Cleanup function
      const cleanup = () => {
        isStreamClosed = true;
        queueEvents.off('progress', progressHandler);
        queueEvents.off('completed', completedHandler);
        queueEvents.off('failed', failedHandler);
      };

      // Timeout after 5 minutes
      const timeoutId = setTimeout(() => {
        if (!isStreamClosed) {
          try {
            const timeoutData = JSON.stringify({
              type: 'timeout',
              sessionId,
              message: 'Stream timeout after 5 minutes. Check session status via API.',
              timestamp: new Date().toISOString(),
            });
            controller.enqueue(encoder.encode(`event: timeout\ndata: ${timeoutData}\n\n`));
          } catch {
            // Ignore
          }
          cleanup();
          controller.close();
        }
      }, 5 * 60 * 1000);

      // Heartbeat every 30 seconds
      const heartbeatId = setInterval(() => {
        if (!isStreamClosed) {
          try {
            const heartbeatData = JSON.stringify({
              type: 'heartbeat',
              sessionId,
              timestamp: new Date().toISOString(),
            });
            controller.enqueue(encoder.encode(`event: heartbeat\ndata: ${heartbeatData}\n\n`));
          } catch {
            // Stream may be closed
            clearInterval(heartbeatId);
          }
        }
      }, 30000);

      // Handle client disconnect
      request.signal.addEventListener('abort', () => {
        cleanup();
        clearTimeout(timeoutId);
        clearInterval(heartbeatId);
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    },
  });
}
