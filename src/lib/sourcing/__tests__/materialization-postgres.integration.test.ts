import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import type { ProfileSummary } from '@/types/linkedin';
import type { CrustdataSearchResult } from '../crustdata-client';
import type { CandidateForRanking } from '../ranking-new';
import {
  acquireCrustdataSearch,
  markCrustdataReceiptMemoryIngested,
  prismaCrustdataReceiptStore,
} from '../crustdata-acquisition';
import {
  enqueuePublicMemoryIngestOutbox,
  hydrateOutboxCandidate,
  type PublicMemoryOutboxEnqueueInput,
  type PublicMemoryOutboxPayload,
} from '../public-memory-ingest-outbox';
import { runPublicMemoryIngestCycle } from '../public-memory-ingest-worker';
import {
  applyCandidateMaterializationResults,
  makeGlobalTemporaryCandidateId,
  materializePublicMemoryCandidates,
  type PublicMemoryMaterializationEntry,
} from '../public-memory-materialization';
import { persistSourcingCandidatesForRequest } from '../sourcing-candidate-persistence';

const postgresEnabled =
  process.env.RUN_SIGNAL_POSTGRES_INTEGRATION === '1';
const describePostgres = postgresEnabled ? describe : describe.skip;

const GOOD_GLOBAL_ID = '11111111-1111-4111-8111-111111111111';
const BAD_GLOBAL_ID = '22222222-2222-4222-8222-222222222222';
const CONFLICTING_GLOBAL_ID =
  '33333333-3333-4333-8333-333333333333';
const PRIVATE_SENTINELS = [
  'private-note@example.com',
  'nested-private@example.com',
  '+1-415-555-0123',
  'drop-private-field',
];

function acquisitionResult(): CrustdataSearchResult {
  return {
    profiles: [
      { crustdata_person_id: 101 },
      { crustdata_person_id: 202 },
    ],
    providerTotal: 2,
    rawReturnedCount: 2,
    requestedLimit: 300,
  };
}

function outboxInput({
  signalCandidateId,
  linkedinId,
  globalCandidateId,
  crustdataPersonId,
}: {
  signalCandidateId: string;
  linkedinId: string;
  globalCandidateId: string;
  crustdataPersonId: number;
}): PublicMemoryOutboxEnqueueInput {
  return {
    candidate: {
      id: signalCandidateId,
      linkedinUrl: `https://www.linkedin.com/in/${linkedinId}`,
      name: `Example Person private-note@example.com`,
      headlineHint:
        'Backend Engineer nested-private@example.com +1-415-555-0123',
      locationHint: 'Bengaluru, India',
      searchTitle: 'Backend Engineer',
      searchSnippet: 'Python platform engineering',
      enrichmentStatus: 'pending',
      lastEnrichedAt: null,
      crustdata: {
        crustdata_person_id: crustdataPersonId,
        unknown_provider_field: 'drop-private-field',
        contact: {
          personal_email: 'nested-private@example.com',
        },
        basic_profile: {
          name: 'Example Person',
          current_title: 'Backend Engineer',
          headline: 'Python platform engineering',
          email: 'nested-private@example.com',
          location: {
            city: 'Bengaluru',
            country: 'India',
            full_location: 'Bengaluru, India',
          },
        },
        social_handles: {
          professional_network_identifier: {
            profile_url:
              `https://www.linkedin.com/in/${linkedinId}`,
          },
        },
      },
      snapshot: null,
    } as CandidateForRanking & {
      linkedinUrl: string;
      name: string;
    },
    options: {
      profileObservedAt: new Date('2026-07-29T00:00:00.000Z'),
      acquisitionGeneration: 1,
    },
    expectedGlobalCandidateId: globalCandidateId,
  };
}

function materializationEntry(
  payload: PublicMemoryOutboxPayload,
  globalCandidateId: string,
): PublicMemoryMaterializationEntry {
  const candidate = hydrateOutboxCandidate(payload);
  const linkedinUrl = candidate.linkedinUrl;
  if (!linkedinUrl) throw new Error('Test candidate has no LinkedIn URL');
  const linkedinId = new URL(linkedinUrl).pathname
    .split('/')
    .filter(Boolean)
    .at(-1);
  if (!linkedinId) throw new Error('Test candidate has no LinkedIn ID');
  return {
    temporaryId: makeGlobalTemporaryCandidateId(globalCandidateId),
    globalCandidateId,
    profile: {
      title: candidate.searchTitle ?? '',
      snippet: candidate.searchSnippet ?? '',
      linkedinUrl,
      linkedinId,
      canonicalLinkedinId: linkedinId,
      name: candidate.name,
      headline: candidate.headlineHint ?? undefined,
      location: candidate.locationHint ?? undefined,
      crustdata: candidate.crustdata,
      providerMeta: {
        publicMemory: {
          surface: 'public_v1',
          globalCandidateId,
        },
      },
    } as ProfileSummary & { canonicalLinkedinId: string },
  };
}

describePostgres(
  'fresh acquisition and receipt replay materialization (PostgreSQL)',
  () => {
    const tenantId = `materialization_test_${randomUUID()}`;
    const requestId = `request_${randomUUID()}`;
    const executionAttemptId = randomUUID();
    const processingLeaseId = randomUUID();
    const goodSignalId = 'signal-good';
    const badSignalId = 'signal-bad';
    let goodCandidateId: string;

    beforeAll(async () => {
      const databaseUrl = process.env.DATABASE_URL ?? '';
      if (!/(?:^|[_-])test(?:[_-]|$)/i.test(new URL(databaseUrl).pathname)) {
        throw new Error(
          'PostgreSQL integration tests require a disposable *_test database',
        );
      }

      await prisma.jobSourcingRequest.create({
        data: {
          id: requestId,
          tenantId,
          externalJobId: `integration:${randomUUID()}`,
          jobContextHash: randomUUID(),
          jobContext: { title: 'Backend Engineer' },
          callbackUrl: 'https://example.invalid/callback',
          status: 'processing',
          acquisitionGeneration: 1,
          executionAttemptId,
          processingLeaseId,
        },
      });

      const goodCandidate = await prisma.candidate.create({
        data: {
          tenantId,
          // The exact URL plus case-variant slug reproduces the old P2002 loop:
          // a case-sensitive slug lookup missed this row, then create collided.
          linkedinId: 'GOOD-PERSON',
          linkedinUrl:
            'https://www.linkedin.com/in/good-person',
          captureSource: 'test',
        },
        select: { id: true },
      });
      goodCandidateId = goodCandidate.id;

      const conflictingCandidate = await prisma.candidate.create({
        data: {
          tenantId,
          linkedinId: 'bad-person',
          linkedinUrl:
            'https://www.linkedin.com/in/bad-person',
          searchTitle: 'Org-private candidate state',
          searchMeta: { privateMarker: 'must-survive' },
          captureSource: 'test',
        },
        select: { id: true },
      });
      await prisma.candidateGlobalLink.create({
        data: {
          tenantId,
          candidateId: conflictingCandidate.id,
          globalCandidateId: CONFLICTING_GLOBAL_ID,
          matchMethod: 'test_conflict',
        },
      });
    });

    afterAll(async () => {
      await prisma.jobSourcingCandidate.deleteMany({
        where: { tenantId },
      });
      await prisma.candidateGlobalLink.deleteMany({
        where: { tenantId },
      });
      await prisma.publicMemoryIngestReceipt.deleteMany({
        where: { tenantId },
      });
      await prisma.publicMemoryIngestOutbox.deleteMany({
        where: { tenantId },
      });
      await prisma.crustdataAcquisitionReceipt.deleteMany({
        where: { tenantId },
      });
      await prisma.jobSourcingRequest.deleteMany({
        where: { tenantId },
      });
      await prisma.candidate.deleteMany({ where: { tenantId } });
      await prisma.$disconnect();
    });

    it('reuses the paid batch, isolates one identity conflict, and persists the rest', async () => {
      const providerSearch = vi.fn().mockResolvedValue(acquisitionResult());
      const acquireInput = {
        tenantId,
        sourcingRequestId: requestId,
        acquisitionGeneration: 1,
        slot: 'exact' as const,
        requirements: {
          title: 'Backend Engineer',
          topSkills: ['python'],
          seniorityLevel: 'senior',
          domain: 'software',
          roleFamily: 'backend',
          location: 'Bengaluru, India',
          experienceYears: 5,
          experienceYearsMax: null,
          education: null,
          titleSearchTerms: ['backend engineer'],
          adjacentBuckets: [],
          adjacentLocations: [],
        },
        limit: 300,
        excludePersonIds: [],
        metadata: {
          rungId: 'exact',
          rungDescription: 'exact job segment',
          submittedExclusionCount: 0,
        },
      };

      const fresh = await acquireCrustdataSearch(acquireInput, {
        store: prismaCrustdataReceiptStore,
        search: providerSearch,
      });
      expect(fresh.reused).toBe(false);

      await enqueuePublicMemoryIngestOutbox({
        tenantId,
        sourcingRequestId: requestId,
        candidates: [
          outboxInput({
            signalCandidateId: goodSignalId,
            linkedinId: 'good-person',
            globalCandidateId: GOOD_GLOBAL_ID,
            crustdataPersonId: 101,
          }),
          outboxInput({
            signalCandidateId: badSignalId,
            linkedinId: 'bad-person',
            globalCandidateId: BAD_GLOBAL_ID,
            crustdataPersonId: 202,
          }),
        ],
      });

      const confirmed = await runPublicMemoryIngestCycle({
        concurrency: 2,
        ingest: async (row) => ({
          success: true,
          signalCandidateId: row.signalCandidateId,
          memoryCandidateId: `memory-${row.signalCandidateId}`,
          globalCandidateId:
            row.signalCandidateId === goodSignalId
              ? GOOD_GLOBAL_ID
              : BAD_GLOBAL_ID,
          sourceRecordId: row.signalCandidateId,
          resolutionStatus: 'created',
          errorCode: null,
        }),
      });
      expect(confirmed).toEqual({
        claimed: 2,
        confirmed: 2,
        failed: 0,
      });
      expect(
        await markCrustdataReceiptMemoryIngested(
          tenantId,
          fresh.receiptId,
          { candidateCount: 2 },
        ),
      ).toBe(true);

      const outboxRows = await prisma.publicMemoryIngestOutbox.findMany({
        where: { tenantId },
        orderBy: { signalCandidateId: 'asc' },
        select: {
          signalCandidateId: true,
          payload: true,
          status: true,
        },
      });
      expect(outboxRows.map((row) => row.status)).toEqual([
        'succeeded',
        'succeeded',
      ]);
      const serializedProjection = JSON.stringify(outboxRows);
      for (const sentinel of PRIVATE_SENTINELS) {
        expect(serializedProjection).not.toContain(sentinel);
      }

      const payloadBySignalId = new Map(
        outboxRows.map((row) => [
          row.signalCandidateId,
          row.payload as unknown as PublicMemoryOutboxPayload,
        ]),
      );
      const entries = [
        materializationEntry(
          payloadBySignalId.get(goodSignalId)!,
          GOOD_GLOBAL_ID,
        ),
        materializationEntry(
          payloadBySignalId.get(badSignalId)!,
          BAD_GLOBAL_ID,
        ),
      ];
      const freshMaterialization =
        await materializePublicMemoryCandidates({
          tenantId,
          entries,
        });
      expect(
        freshMaterialization.materializedByTemporaryId.get(
          makeGlobalTemporaryCandidateId(GOOD_GLOBAL_ID),
        ),
      ).toBe(goodCandidateId);
      expect(freshMaterialization.failures).toEqual([
        {
          globalCandidateId: BAD_GLOBAL_ID,
          code: 'global_link_failed',
        },
      ]);

      const materializedSelection =
        applyCandidateMaterializationResults({
          candidates: [
            {
              candidateId:
                makeGlobalTemporaryCandidateId(GOOD_GLOBAL_ID),
              fitScore: 75,
              rank: 1,
            },
            {
              candidateId:
                makeGlobalTemporaryCandidateId(BAD_GLOBAL_ID),
              fitScore: 74,
              rank: 2,
            },
          ],
          replacements:
            freshMaterialization.materializedByTemporaryId,
          publicTemporaryCandidateIds: new Set(
            entries.map((entry) => entry.temporaryId),
          ),
        });
      expect(materializedSelection.skippedTemporaryCandidateIds).toEqual([
        makeGlobalTemporaryCandidateId(BAD_GLOBAL_ID),
      ]);
      await persistSourcingCandidatesForRequest({
        requestId,
        tenantId,
        executionFence: {
          acquisitionGeneration: 1,
          executionAttemptId,
          processingLeaseId,
        },
        materializationDiagnostics: {
          failureCount: freshMaterialization.failures.length,
          failures: freshMaterialization.failures,
        },
        data: materializedSelection.candidates.map(
          (candidate, index) => ({
            tenantId,
            sourcingRequestId: requestId,
            candidateId: candidate.candidateId,
            fitScore: candidate.fitScore,
            sourceType: 'pool',
            enrichmentStatus: 'pending',
            rank: index + 1,
          }),
        ),
      });

      const replay = await acquireCrustdataSearch(acquireInput, {
        store: prismaCrustdataReceiptStore,
        search: providerSearch,
      });
      expect(replay).toMatchObject({
        reused: true,
        receiptId: fresh.receiptId,
      });
      expect(replay.memoryIngestedAt).not.toBeNull();
      expect(providerSearch).toHaveBeenCalledTimes(1);

      const replayExecutionAttemptId = randomUUID();
      const replayProcessingLeaseId = randomUUID();
      await prisma.jobSourcingRequest.update({
        where: { id: requestId },
        data: {
          status: 'processing',
          executionAttemptId: replayExecutionAttemptId,
          processingLeaseId: replayProcessingLeaseId,
        },
      });
      const replayConfirmation = await runPublicMemoryIngestCycle({
        ingest: vi.fn(),
      });
      expect(replayConfirmation.claimed).toBe(0);
      const replayMaterialization =
        await materializePublicMemoryCandidates({
          tenantId,
          entries,
        });
      expect(replayMaterialization.failures).toEqual(
        freshMaterialization.failures,
      );
      expect(
        replayMaterialization.materializedByTemporaryId.size,
      ).toBe(1);
      const replaySelection = applyCandidateMaterializationResults({
        candidates: [
          {
            candidateId:
              makeGlobalTemporaryCandidateId(GOOD_GLOBAL_ID),
            fitScore: 75,
          },
          {
            candidateId:
              makeGlobalTemporaryCandidateId(BAD_GLOBAL_ID),
            fitScore: 74,
          },
        ],
        replacements:
          replayMaterialization.materializedByTemporaryId,
        publicTemporaryCandidateIds: new Set(
          entries.map((entry) => entry.temporaryId),
        ),
      });
      await persistSourcingCandidatesForRequest({
        requestId,
        tenantId,
        executionFence: {
          acquisitionGeneration: 1,
          executionAttemptId: replayExecutionAttemptId,
          processingLeaseId: replayProcessingLeaseId,
        },
        materializationDiagnostics: {
          failureCount: replayMaterialization.failures.length,
          failures: replayMaterialization.failures,
        },
        data: replaySelection.candidates.map((candidate, index) => ({
            tenantId,
            sourcingRequestId: requestId,
            candidateId: candidate.candidateId,
            fitScore: candidate.fitScore,
            sourceType: 'pool',
            enrichmentStatus: 'pending',
            rank: index + 1,
          })),
      });

      const [
        request,
        persistedCandidates,
        storedGoodCandidate,
        storedBadCandidate,
      ] =
        await Promise.all([
          prisma.jobSourcingRequest.findUniqueOrThrow({
            where: { id: requestId },
            select: { diagnostics: true },
          }),
          prisma.jobSourcingCandidate.findMany({
            where: { sourcingRequestId: requestId },
            orderBy: { rank: 'asc' },
          }),
          prisma.candidate.findUniqueOrThrow({
            where: { id: goodCandidateId },
            select: { searchMeta: true },
          }),
          prisma.candidate.findFirstOrThrow({
            where: { tenantId, linkedinId: 'bad-person' },
            select: { searchTitle: true, searchMeta: true },
          }),
        ]);
      expect(persistedCandidates).toHaveLength(1);
      expect(persistedCandidates[0]).toMatchObject({
        candidateId: goodCandidateId,
        rank: 1,
      });
      expect(request.diagnostics).toMatchObject({
        publicMemory: {
          materializationFailures: 1,
          materializationFailureDetails: [
            {
              globalCandidateId: BAD_GLOBAL_ID,
              code: 'global_link_failed',
            },
          ],
        },
      });
      const serializedStoredProfile = JSON.stringify(
        storedGoodCandidate.searchMeta,
      );
      for (const sentinel of PRIVATE_SENTINELS) {
        expect(serializedStoredProfile).not.toContain(sentinel);
      }
      expect(storedBadCandidate).toEqual({
        searchTitle: 'Org-private candidate state',
        searchMeta: { privateMarker: 'must-survive' },
      });
    });
  },
);
