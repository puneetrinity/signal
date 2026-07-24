/**
 * Manual production drift check for the two-layer pool read.
 *
 * This deliberately uses real service credentials and is not a CI test. Run
 * it before changing Memory search limits, location filters, or embedding text.
 *
 * Usage:
 *   DATABASE_URL=... ACTIVEGRAPH_URL=... SIGNAL_JWT_PRIVATE_KEY=... \
 *     npx tsx scripts/topk-check.ts --job 147 --limit 500
 */

import { prisma } from '@/lib/prisma';
import { searchGlobalPool } from '@/lib/sourcing/activegraph-client';
import { extractLinkedInIdFromUrl } from '@/lib/sourcing/discovery';
import { buildJobRequirements } from '@/lib/sourcing/jd-digest';

function readOption(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

async function main() {
  const jobId = readOption('--job', '147');
  const limit = Number(readOption('--limit', '500'));
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');

  const request = await prisma.jobSourcingRequest.findFirst({
    where: { externalJobId: `vanta:jobs:${jobId}`, status: 'complete' },
    orderBy: { requestedAt: 'desc' },
  });
  if (!request) throw new Error(`No completed sourcing request found for Flow job ${jobId}`);

  const requirements = buildJobRequirements(request.jobContext as never);
  const vector = await searchGlobalPool(requirements, request.tenantId, limit, `topk-check-${jobId}`);
  if (!vector) throw new Error('Memory vector search was unavailable');

  const vectorSlugs = new Set(
    vector
      .map((candidate) => candidate.linkedin_id
        ?? extractLinkedInIdFromUrl(candidate.linkedin_url ?? ''))
      .filter((slug): slug is string => !!slug)
      .map((slug) => slug.toLowerCase()),
  );
  const served = await prisma.jobSourcingCandidate.findMany({
    where: {
      sourcingRequestId: request.id,
      sourceType: { in: ['pool', 'pool_enriched'] },
    },
    orderBy: { rank: 'asc' },
    select: {
      rank: true,
      fitScore: true,
      candidate: { select: { linkedinId: true, linkedinUrl: true } },
    },
  });

  const isCovered = (candidate: (typeof served)[number]) => {
    const slug = candidate.candidate.linkedinId
      || extractLinkedInIdFromUrl(candidate.candidate.linkedinUrl || '');
    return slug ? vectorSlugs.has(slug.toLowerCase()) : false;
  };
  const top20 = served.filter((candidate) => (candidate.rank ?? Number.MAX_SAFE_INTEGER) <= 20);

  console.log(JSON.stringify({
    jobId: Number(jobId),
    requestId: request.id,
    vectorResults: vector.length,
    servedPoolCandidates: served.length,
    servedCovered: served.filter(isCovered).length,
    top20Candidates: top20.length,
    top20Covered: top20.filter(isCovered).length,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
