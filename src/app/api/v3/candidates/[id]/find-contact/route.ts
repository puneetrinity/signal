import { NextRequest, NextResponse } from 'next/server';
import { verifyServiceJWT } from '@/lib/auth/service-jwt';
import { requireScope } from '@/lib/auth/service-scopes';
import { prisma } from '@/lib/prisma';

async function performFullEnrich(candidate: any, fullEnrichKey: string): Promise<string[]> {
  const parts = (candidate.nameHint || '').trim().split(/\s+/);
  const firstName = parts[0] || '';
  const lastName = parts.slice(1).join(' ') || '';
  
  const payload = {
    name: candidate.nameHint || 'Unknown Candidate',
    data: [{
      first_name: firstName,
      last_name: lastName,
      company_name: candidate.companyHint || '',
      linkedin_url: candidate.linkedinUrl,
      enrich_fields: ["contact.personal_emails"]
    }]
  };

  const startRes = await fetch('https://app.fullenrich.com/api/v2/contact/enrich/bulk', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${fullEnrichKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!startRes.ok) {
    throw new Error(`FullEnrich POST failed: ${startRes.status} ${await startRes.text()}`);
  }

  const startData = await startRes.json();
  const enrichmentId = startData.enrichment_id;
  if (!enrichmentId) {
    throw new Error('FullEnrich did not return an enrichment_id');
  }

  // Polling loop
  const maxRetries = 20; // approx 40s
  for (let i = 0; i < maxRetries; i++) {
    await new Promise(r => setTimeout(r, 2000));

    const pollRes = await fetch(`https://app.fullenrich.com/api/v2/contact/enrich/bulk/${enrichmentId}`, {
      headers: { 'Authorization': `Bearer ${fullEnrichKey}` }
    });

    if (!pollRes.ok) {
      throw new Error(`FullEnrich GET failed: ${pollRes.status} ${await pollRes.text()}`);
    }

    const pollData = await pollRes.json();
    if (pollData.status === 'FINISHED') {
      const contactInfo = pollData.data?.[0]?.contact_info;
      if (!contactInfo) return [];

      const emails: string[] = [];
      if (contactInfo.work_emails) {
        emails.push(...contactInfo.work_emails.map((e: any) => e.email));
      }
      if (contactInfo.personal_emails) {
        emails.push(...contactInfo.personal_emails.map((e: any) => e.email));
      }
      return [...new Set(emails)].filter(Boolean); // Deduplicate
    }
  }

  throw new Error('FullEnrich polling timed out');
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await verifyServiceJWT(request);
  if (!auth.authorized) return auth.response;

  // Signal v3 uses jobs:source for enrichment actions
  const scopeCheck = requireScope(auth.context, 'jobs:source');
  if (!scopeCheck.authorized) return scopeCheck.response;

  const { id: candidateId } = await params;
  const tenantId = auth.context.tenantId;

  try {
    const candidate = await prisma.candidate.findUnique({
      where: { id: candidateId },
    });

    if (!candidate || candidate.tenantId !== tenantId) {
      return NextResponse.json({ error: 'Candidate not found' }, { status: 404 });
    }

    if (!candidate.linkedinUrl) {
      return NextResponse.json({ error: 'Candidate has no LinkedIn URL' }, { status: 400 });
    }

    let emails: string[] = [];
    let fullEnrichError = '';

    const fullEnrichKey = process.env.FULLENRICH_API_KEY;
    if (fullEnrichKey) {
      try {
        emails = await performFullEnrich(candidate, fullEnrichKey);
      } catch (err: any) {
        console.error('FullEnrich failed, falling back to Enrichlayer:', err.message);
        fullEnrichError = err.message;
      }
    }

    if (emails.length === 0) {
      const enrichlayerKey = process.env.ENRICHLAYER_API_KEY;
      if (!enrichlayerKey) {
        return NextResponse.json({ error: fullEnrichError ? `FullEnrich failed (${fullEnrichError}) and no Enrichlayer fallback key is configured` : 'No API keys configured for enrichment' }, { status: 500 });
      }

      const apiUrl = new URL('https://enrichlayer.com/api/v2/contact-api/personal-email');
      apiUrl.searchParams.append('profile_url', candidate.linkedinUrl);
      apiUrl.searchParams.append('email_validation', 'fast');
      apiUrl.searchParams.append('page_size', '0');

      const res = await fetch(apiUrl.toString(), {
        headers: {
          'Authorization': `Bearer ${enrichlayerKey}`,
        },
      });

      if (!res.ok) {
        const text = await res.text();
        let errorMsg = 'Failed to enrich contact from external service';
        try {
          const parsed = JSON.parse(text);
          if (parsed.description) {
            errorMsg = `Enrichlayer: ${parsed.description}`;
          }
        } catch (e) {
          // Not JSON
        }
        console.error('Enrichlayer error:', res.status, text);
        return NextResponse.json({ error: errorMsg, details: text, status: res.status }, { status: 502 });
      }

      const data = await res.json();
      emails = data.emails || [];
    }

    if (emails.length > 0) {
      // Update candidate searchMeta
      let searchMeta = candidate.searchMeta as any;
      if (!searchMeta || typeof searchMeta !== 'object') searchMeta = {};
      if (!searchMeta.crustdata || typeof searchMeta.crustdata !== 'object') searchMeta.crustdata = {};
      if (!searchMeta.crustdata.contact || typeof searchMeta.crustdata.contact !== 'object') searchMeta.crustdata.contact = {};
      
      searchMeta.crustdata.contact.has_personal_email = true;
      searchMeta.crustdata.emails = emails;

      await prisma.candidate.update({
        where: { id: candidateId },
        data: { searchMeta },
      });
    }

    return NextResponse.json({
      success: true,
      emails,
    });
  } catch (err: any) {
    console.error('Error in find-contact:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
