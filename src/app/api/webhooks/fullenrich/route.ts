import { NextRequest, NextResponse } from 'next/server';
import {
  verifyFullEnrichSignature,
} from '@/lib/contact-enrichment/fullenrich-webhook';
import { handleFullEnrichWebhookPayload } from '@/lib/contact-enrichment/webhook-handler';

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const apiKey = process.env.FULLENRICH_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { success: false, error: 'Webhook not configured' },
      { status: 503 },
    );
  }
  if (
    !verifyFullEnrichSignature(
      rawBody,
      request.headers.get('x-signature-sha1'),
      apiKey,
    )
  ) {
    return NextResponse.json(
      { success: false, error: 'Invalid signature' },
      { status: 401 },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid payload' },
      { status: 400 },
    );
  }
  try {
    const result = await handleFullEnrichWebhookPayload(payload);
    if (!result.accepted) {
      return NextResponse.json(
        { success: false, error: 'Invalid payload identity' },
        { status: 400 },
      );
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[FullEnrichWebhook] Processing failed', {
      errorType:
        error instanceof Error ? error.name : 'unknown',
    });
    return NextResponse.json(
      { success: false, error: 'Webhook processing failed' },
      { status: 500 },
    );
  }
}
