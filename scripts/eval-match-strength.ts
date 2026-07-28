/**
 * Read-only replay of percentile match-strength labels over captured Flow JSON
 * payloads or persisted Signal sourcing runs.
 *
 * Usage:
 *   npx tsx scripts/eval-match-strength.ts \
 *     --input /path/to/cands148.json --input /path/to/cands149.json
 *
 *   DATABASE_URL=... npx tsx scripts/eval-match-strength.ts --jobs 147-153
 */

import { readFile } from "node:fs/promises";
import {
  evaluateMatchStrengthReplay,
  type MatchStrengthReplayCandidate,
} from "@/lib/sourcing/match-strength-replay";

type JsonObject = Record<string, unknown>;

function safeObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" ? (value as JsonObject) : null;
}

function repeatedOptions(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) {
      values.push(process.argv[index + 1]!);
      index += 1;
    }
  }
  return values;
}

function singleOption(name: string): string | null {
  return repeatedOptions(name)[0] ?? null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseJobIds(spec: string | null): number[] {
  if (!spec) return [];
  const ids = new Set<number>();
  for (const token of spec.split(",")) {
    const trimmed = token.trim();
    const range = trimmed.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end)
        throw new Error(`Invalid descending job range: ${trimmed}`);
      for (let id = start; id <= end; id += 1) ids.add(id);
      continue;
    }
    const id = Number(trimmed);
    if (!Number.isInteger(id) || id < 1) {
      throw new Error(`Invalid job id: ${trimmed}`);
    }
    ids.add(id);
  }
  return [...ids];
}

function captureCandidate(
  value: unknown,
  index: number,
): MatchStrengthReplayCandidate {
  const candidate = safeObject(value);
  if (!candidate)
    throw new Error(`Capture candidate ${index} is not an object`);
  const fitBreakdown = safeObject(candidate.fitBreakdown);
  const candidateId =
    candidate.signalCandidateId ?? candidate.candidateId ?? candidate.id;
  if (typeof candidateId !== "string" && typeof candidateId !== "number") {
    throw new Error(`Capture candidate ${index} has no stable id`);
  }

  return {
    candidateId: String(candidateId),
    rank:
      finiteNumber(candidate.signalRank) ??
      finiteNumber(candidate.rank) ??
      index + 1,
    fitScore:
      finiteNumber(candidate.fitScoreRaw) ?? finiteNumber(candidate.fitScore),
    skillScoreMethod: fitBreakdown?.skillScoreMethod ?? null,
    sourceType:
      typeof candidate.sourceType === "string"
        ? candidate.sourceType
        : undefined,
  };
}

async function loadCapture(path: string) {
  const payload = safeObject(JSON.parse(await readFile(path, "utf8")));
  if (!payload || !Array.isArray(payload.candidates)) {
    throw new Error(`${path} does not contain a candidates array`);
  }
  const candidates = payload.candidates
    .map(captureCandidate)
    .sort(
      (a, b) => a.rank - b.rank || a.candidateId.localeCompare(b.candidateId),
    );
  const firstCandidate = safeObject(payload.candidates[0]);
  const jobId =
    finiteNumber(payload.jobId) ?? finiteNumber(firstCandidate?.jobId) ?? path;
  return evaluateMatchStrengthReplay(jobId, candidates);
}

async function loadPersistedRuns(jobIds: number[]) {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required with --jobs");
  }
  const { prisma } = await import("@/lib/prisma");
  try {
    const reports = [];
    for (const jobId of jobIds) {
      const request = await prisma.jobSourcingRequest.findFirst({
        where: {
          externalJobId: `vanta:jobs:${jobId}`,
          status: "complete",
        },
        orderBy: { requestedAt: "desc" },
        select: {
          candidates: {
            orderBy: { rank: "asc" },
            select: {
              candidateId: true,
              rank: true,
              fitScore: true,
              fitBreakdown: true,
              sourceType: true,
            },
          },
        },
      });
      if (!request) {
        throw new Error(
          `No completed sourcing request found for Flow job ${jobId}`,
        );
      }
      reports.push(
        evaluateMatchStrengthReplay(
          jobId,
          request.candidates.map((candidate) => ({
            candidateId: candidate.candidateId,
            rank: candidate.rank,
            fitScore: candidate.fitScore,
            skillScoreMethod:
              safeObject(candidate.fitBreakdown)?.skillScoreMethod ?? null,
            sourceType: candidate.sourceType,
          })),
        ),
      );
    }
    return reports;
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const inputPaths = repeatedOptions("--input");
  const jobIds = parseJobIds(singleOption("--jobs"));
  if (inputPaths.length === 0 && jobIds.length === 0) {
    throw new Error("Provide at least one --input or a --jobs list/range");
  }

  const captureReports = await Promise.all(inputPaths.map(loadCapture));
  const persistedReports =
    jobIds.length > 0 ? await loadPersistedRuns(jobIds) : [];
  console.log(
    JSON.stringify(
      {
        calibration: {
          strong:
            "run p80 > p50 AND fitScore >= max(run p80, 60) AND skillScoreMethod=snapshot",
          good: "fitScore >= max(run p50, 60)",
          possible: "fitScore below effective good threshold or unavailable",
        },
        runs: [...captureReports, ...persistedReports],
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
