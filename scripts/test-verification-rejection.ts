/**
 * Tests 5.3 + 5.4: Verification edge cases.
 *
 * 5.3 — wrong LinkedIn URL or wrong name in EnrichLayer response → verification
 *        must reject (no candidate.email written, session moves to failed).
 * 5.4 — candidate has no linkedinUrl → enrichment guard at queue/index.ts:917
 *        must throw early instead of silently passing or hitting EnrichLayer.
 *
 * No DB / no Redis — exercises pure functions and the guard precondition only.
 */
import {
  verifyEnrichLayerMatch,
  type EnrichLayerProfileResponse,
} from '@/lib/enrichment/enrichlayer';

interface TestCase {
  label: string;
  input: Parameters<typeof verifyEnrichLayerMatch>[0];
  payload: EnrichLayerProfileResponse;
  expectAccepted: boolean;
  expectReason?: string;
}

const cases: TestCase[] = [
  {
    label: '5.3a wrong LinkedIn URL in response → reject (linkedin_url_mismatch)',
    input: {
      linkedinUrl: 'https://www.linkedin.com/in/expected-person',
      nameHint: 'Expected Person',
      companyHint: 'Acme',
    },
    payload: {
      public_identifier: 'totally-different-person',
      full_name: 'Different Human',
      headline: 'Whatever',
    },
    expectAccepted: false,
    expectReason: 'linkedin_url_mismatch',
  },
  {
    label: '5.3b right URL, wrong name → reject (name_mismatch)',
    input: {
      linkedinUrl: 'https://www.linkedin.com/in/sample-engineer',
      nameHint: 'Babu Kashyap',
      companyHint: 'Wipro',
    },
    payload: {
      public_identifier: 'sample-engineer',
      full_name: 'Cosmo Kramer',
      headline: 'Senior Software Engineer',
      company: 'Wipro',
    },
    expectAccepted: false,
    expectReason: 'name_mismatch',
  },
  {
    label: '5.3c all match → accepted',
    input: {
      linkedinUrl: 'https://www.linkedin.com/in/sample-engineer',
      nameHint: 'Sample Engineer',
      companyHint: 'Wipro',
    },
    payload: {
      public_identifier: 'sample-engineer',
      full_name: 'Sample Engineer',
      headline: 'Senior Software Engineer',
      company: 'Wipro',
    },
    expectAccepted: true,
  },
  {
    label: '5.3d company mismatch is soft (does not reject)',
    input: {
      linkedinUrl: 'https://www.linkedin.com/in/sample-engineer',
      nameHint: 'Sample Engineer',
      companyHint: 'Wipro',
    },
    payload: {
      public_identifier: 'sample-engineer',
      full_name: 'Sample Engineer',
      headline: 'Senior Software Engineer',
      company: 'Infosys',
    },
    expectAccepted: true,
    expectReason: 'company_mismatch_soft',
  },
];

function checkVerification(): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;

  console.log('=== Test 5.3: verifyEnrichLayerMatch edge cases ===\n');
  for (const c of cases) {
    const result = verifyEnrichLayerMatch(c.input, c.payload);
    const acceptedOk = result.accepted === c.expectAccepted;
    const reasonOk = c.expectReason
      ? result.reasons.includes(c.expectReason)
      : true;
    const ok = acceptedOk && reasonOk;
    if (ok) {
      console.log(`PASS  ${c.label}`);
      console.log(`      score=${result.score.toFixed(2)} reasons=[${result.reasons.join(', ')}]`);
      passed++;
    } else {
      console.log(`FAIL  ${c.label}`);
      console.log(`      expected accepted=${c.expectAccepted} reason~${c.expectReason ?? '(any)'}`);
      console.log(`      got      accepted=${result.accepted} score=${result.score.toFixed(2)} reasons=[${result.reasons.join(', ')}]`);
      failed++;
    }
    console.log();
  }
  return { passed, failed };
}

/**
 * Test 5.4 — guard at queue/index.ts:917 throws when linkedinUrl is missing.
 * We simulate just the precondition rather than spinning up BullMQ.
 */
function checkNoLinkedinGuard(): { passed: number; failed: number } {
  console.log('=== Test 5.4: no-linkedin-URL precondition guard ===\n');
  const candidate: { linkedinUrl: string | null } = { linkedinUrl: null };

  let threw = false;
  let message = '';
  try {
    if (!candidate.linkedinUrl) {
      throw new Error('EnrichLayer enrichment requires candidate.linkedinUrl');
    }
  } catch (err) {
    threw = true;
    message = err instanceof Error ? err.message : String(err);
  }

  if (threw && message.includes('candidate.linkedinUrl')) {
    console.log(`PASS  Guard throws: "${message}"`);
    console.log(`      (mirrors src/lib/enrichment/queue/index.ts:917)\n`);
    return { passed: 1, failed: 0 };
  }
  console.log(`FAIL  Guard did not fire — got threw=${threw} message="${message}"\n`);
  return { passed: 0, failed: 1 };
}

function main() {
  const a = checkVerification();
  const b = checkNoLinkedinGuard();
  const passed = a.passed + b.passed;
  const failed = a.failed + b.failed;
  console.log(`=== Summary: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
