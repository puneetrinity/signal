import { PrismaClient } from '@prisma/client';
import { rankCandidates, type CandidateForRanking } from './ranking';
import { buildJobRequirements } from './jd-digest';
import type { CrustdataProfileResponse } from './crustdata-client';

const prisma = new PrismaClient();

async function run() {
  console.log("Fetching all jobs...");
  const jobs = await prisma.jobs.findMany({
    include: { job_sourced_candidates: true }
  });

  for (const job of jobs) {
    if (!job.job_sourced_candidates.length) continue;
    console.log(`Re-ranking candidates for job ${job.id}: ${job.title}`);
    
    // Build requirements
    let jdDigestStr = '';
    if (job.jd_digest) {
      jdDigestStr = typeof job.jd_digest === 'string' ? job.jd_digest : JSON.stringify(job.jd_digest);
    }
    const req = buildJobRequirements({
      jdDigest: jdDigestStr,
      title: job.title || undefined,
      location: job.location || undefined,
    });

    const candidatesToRank: CandidateForRanking[] = job.job_sourced_candidates.map(c => {
      let crustdata = null;
      try {
        if (c.candidate_summary) {
           const sum = typeof c.candidate_summary === 'string' ? JSON.parse(c.candidate_summary) : c.candidate_summary;
           // Actual path: candidate_summary.candidate.searchMeta.crustdata
           crustdata = sum?.candidate?.searchMeta?.crustdata ?? null;
        }
      } catch (e) {}

      return {
        id: c.signal_candidate_id,
        headlineHint: null,
        locationHint: null,
        crustdata: crustdata as CrustdataProfileResponse,
      };
    });

    const scored = rankCandidates(candidatesToRank, req, { track: 'tech' });

    for (const sc of scored) {
      await prisma.job_sourced_candidates.update({
        where: { id: job.job_sourced_candidates.find(c => c.signal_candidate_id === sc.candidateId)?.id },
        data: {
          fit_score: sc.fitScore,
          fit_breakdown: sc.fitBreakdown as any,
        }
      });
    }
    console.log(`Updated ${scored.length} candidates for job ${job.id}`);
  }
  console.log("Done.");
}

run().catch(console.error).finally(() => prisma.$disconnect());
