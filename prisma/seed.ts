import { PrismaClient } from '@prisma/client';
import { faker } from '@faker-js/faker';
import crypto from 'crypto';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting Deep Data Seeder (Every Single Column & Table)...');
  const TOTAL_JOBS = 10;
  const CANDIDATES_PER_JOB = 200; // Total 2000 Candidates to keep massive table growth fast.

  const TENANT_ID = 'dev-tenant';

  // 1. Ensure Tenant Settings exist
  console.log(`🔧 Generating TenantSettings and Global configurations...`);
  await prisma.tenantSettings.upsert({
    where: { tenantId: TENANT_ID },
    update: {},
    create: {
      tenantId: TENANT_ID,
      plan: 'enterprise',
      rateLimitMultiplier: 10.0,
      maxEnrichmentsPerDay: 50000,
      maxQueriesPerEnrichment: 100,
      maxParallelPlatforms: 5,
      features: { summaryEnabled: true, autoConfirmHighConfidence: true },
      allowContactStorage: true,
      planSince: faker.date.recent({ days: 365 })
    }
  });

  const techSkills = ['React.js', 'Node.js', 'TypeScript', 'Rust', 'Go', 'Python', 'Docker', 'Kubernetes', 'AWS', 'GraphQL', 'PostgreSQL', 'Redis', 'Kafka', 'Terraform', 'Next.js', 'TailwindCSS'];
  const titles = ['Software Engineer', 'Backend Engineer', 'Frontend Developer', 'Full Stack Engineer', 'Site Reliability Engineer', 'Data Scientist', 'Machine Learning Engineer'];

  for (let j = 0; j < TOTAL_JOBS; j++) {
    const jobTitle = faker.helpers.arrayElement(titles);
    console.log(`\n📦 Generating Job Request ${j + 1}/${TOTAL_JOBS}: ${jobTitle} (Deep Seed)...`);

    // Create the Job Sourcing Request
    const jobReqId = crypto.randomUUID();
    await prisma.jobSourcingRequest.create({
      data: {
        id: jobReqId,
        tenantId: TENANT_ID,
        externalJobId: `deep-seed-job-${Date.now()}-${j}`,
        jobContextHash: crypto.randomUUID(),
        jobContext: {
          title: jobTitle,
          description: faker.lorem.paragraphs({ min: 1, max: 2 }),
          skills: faker.helpers.arrayElements(techSkills, 5),
          experienceYears: faker.number.int({ min: 2, max: 10 })
        },
        callbackUrl: 'https://webhook.site/' + crypto.randomUUID(),
        status: 'completed',
        requestedAt: faker.date.recent({ days: 10 }),
        completedAt: new Date(),
        callbackAttempts: faker.number.int({ min: 1, max: 3 }),
        lastCallbackError: null,
        callbackStatus: 'success',
        callbackSentAt: new Date(),
        resultCount: CANDIDATES_PER_JOB,
        qualityGateTriggered: false,
        queriesExecuted: faker.number.int({ min: 10, max: 50 }),
        diagnostics: { memoryUsed: '120MB', queriesPerSecond: '12', langgraphNodesIterated: 45 },
        lastRerankedAt: new Date()
      }
    });

    const candidatesChunk = [];
    const jobCandidatesChunk = [];
    const snapshotsChunk = [];
    const identityCandidatesChunk = [];
    const confirmedIdentitiesChunk = [];
    const enrichmentSessionsChunk = [];
    const auditLogsChunk = [];

    for (let c = 0; c < CANDIDATES_PER_JOB; c++) {
      const candidateId = crypto.randomUUID();
      const username = faker.internet.username().toLowerCase().replace(/[^a-z0-9]/g, '') + '-' + Date.now();
      const company = faker.company.name();
      const name = faker.person.fullName();
      const location = faker.location.city() + ', ' + faker.location.country();
      const email = faker.internet.email({ firstName: name, provider: 'gmail.com' });

      // Core Candidate
      candidatesChunk.push({
        id: candidateId,
        tenantId: TENANT_ID,
        linkedinUrl: `https://linkedin.com/in/${username}`,
        linkedinId: username,
        searchTitle: `${name} - ${jobTitle} - ${company}`,
        searchSnippet: faker.lorem.sentence(),
        searchMeta: { kgId: '/m/xxxxx', providerMeta: "serper_premium_result" },
        nameHint: name,
        headlineHint: jobTitle,
        companyHint: company,
        locationHint: location,
        roleType: 'engineer',
        captureSource: 'search',
        searchQuery: `site:linkedin.com/in "${jobTitle}" "${company}"`,
        searchProvider: 'serper',
        enrichmentStatus: 'completed',
        lastEnrichedAt: new Date(),
        confidenceScore: faker.number.float({ min: 0.6, max: 0.99, fractionDigits: 3 }),
        createdAt: faker.date.recent({ days: 30 })
      });

      // Link Job <-> Candidate
      jobCandidatesChunk.push({
        id: crypto.randomUUID(),
        tenantId: TENANT_ID,
        sourcingRequestId: jobReqId,
        candidateId: candidateId,
        fitScore: faker.number.float({ min: 0.1, max: 0.98, fractionDigits: 3 }),
        fitBreakdown: { titleMatch: 0.9, skillMatch: 0.85, cultureMatch: 0.99 },
        sourceType: 'search',
        enrichmentStatus: 'completed',
        rank: c + 1
      });

      // Deep Intelligence Snapshot
      const staleDate = new Date();
      staleDate.setFullYear(staleDate.getFullYear() + 1);
      snapshotsChunk.push({
        id: crypto.randomUUID(),
        candidateId: candidateId,
        tenantId: TENANT_ID,
        track: 'tech',
        skillsNormalized: faker.helpers.arrayElements(techSkills, faker.number.int({ min: 2, max: 8 })),
        roleType: 'engineer',
        seniorityBand: faker.helpers.arrayElement(['Junior', 'MidLevel', 'Senior', 'Staff', 'Principal', 'Distinguished']),
        location: location,
        industries: [faker.word.noun(), faker.word.noun()],
        activityRecencyDays: faker.number.int({ min: 1, max: 60 }),
        computedAt: new Date(),
        staleAfter: staleDate,
        sourceSessionId: crypto.randomUUID(),
        sourceFingerprint: crypto.randomUUID(),
        signalsJson: {
          github: { username, verifiedEmails: [email], totalCommits: faker.number.int({ min: 100, max: 5000 }), followers: faker.number.int({ min: 10, max: 500 }) },
          stackOverflow: { reputation: faker.number.int({ min: 100, max: 10000 }) }
        }
      });

      // Identity Candidate (Unconfirmed Signal Pointer)
      const icId = crypto.randomUUID();
      identityCandidatesChunk.push({
        id: icId,
        tenantId: TENANT_ID,
        candidateId: candidateId,
        platform: 'github',
        platformId: username,
        profileUrl: `https://github.com/${username}`,
        status: 'confirmed',
        confidence: faker.number.float({ min: 0.7, max: 0.99, fractionDigits: 2 }),
        confidenceBucket: 'auto_merge',
        scoreBreakdown: { nameMatch: 1.0, bridgeWeight: 0.8, companyMatch: 0.5 },
        bridgeTier: 1,
        bridgeSignals: ['linkedin_url_in_bio', 'exact_name_match'],
        persistReason: 'high_confidence_bridge',
        evidence: { type: 'commit_email', commitUrl: `https://github.com/${username}/repo/commit/${crypto.randomUUID()}` },
        hasContradiction: false,
        discoveredAt: new Date(),
        discoveredBy: 'system',
        searchQuery: `"${name}" site:github.com`
      });

      // Confirmed Identity (Actual Extracted PII)
      confirmedIdentitiesChunk.push({
        id: crypto.randomUUID(),
        tenantId: TENANT_ID,
        candidateId: candidateId,
        platform: 'github',
        platformId: username,
        profileUrl: `https://github.com/${username}`,
        contactInfo: { email, source: "github_commit", sourceUrl: `https://github.com/${username}/repo` },
        profileData: { bio: faker.lorem.paragraph(), followers: 150, public_repos: 45 },
        confirmedBy: 'auto:high_confidence',
        confirmedAt: new Date(),
        confirmationNote: 'Automatically merged via LangGraph workflow',
        identityCandidateId: icId
      });

      // Detailed Enrichment trace session
      enrichmentSessionsChunk.push({
        id: crypto.randomUUID(),
        tenantId: TENANT_ID,
        candidateId: candidateId,
        status: 'completed',
        roleType: 'engineer',
        sourcesPlanned: ['github', 'stackoverflow', 'medium'],
        sourcesExecuted: ['github'],
        queriesPlanned: 10,
        queriesExecuted: 2,
        earlyStopReason: 'confidence_threshold',
        identitiesFound: 3,
        identitiesConfirmed: 1,
        finalConfidence: 0.99,
        startedAt: faker.date.recent(),
        completedAt: new Date(),
        durationMs: faker.number.int({ min: 5000, max: 20000 }),
        summary: `Found high confidence github profile for ${name}`,
        summaryStructured: { tech_score: 95, red_flags: 0 },
        summaryEvidence: [{ type: 'commit', url: `https://github.com/${username}/repo` }],
        summaryModel: 'groq:llama3-70b-8192',
        summaryTokens: faker.number.int({ min: 500, max: 1500 }),
        summaryGeneratedAt: new Date(),
        runTrace: {
          steps: [
            { name: "bridge_discovery", durationMs: 2000, output: "Success" },
            { name: "github_commit_extraction", durationMs: 4000, output: "Extracted Email" }
          ]
        }
      });

      // General Compliance Audit Logs
      auditLogsChunk.push({
        id: crypto.randomUUID(),
        tenantId: TENANT_ID,
        action: 'identity.confirmed',
        resourceType: 'confirmed_identity',
        resourceId: String(candidateId),
        actorType: 'system',
        metadata: { method: "auto_merge", reason: "confident_bridge" },
        ipAddress: '127.0.0.1',
        userAgent: 'LangGraph Worker / v1.0'
      });
    }

    // Insert the massive deep chunk
    console.log(`   - Inserting ${CANDIDATES_PER_JOB} Candidates...`);
    await prisma.candidate.createMany({ data: candidatesChunk });

    console.log(`   - Linking Jobs & Snapshots...`);
    await prisma.jobSourcingCandidate.createMany({ data: jobCandidatesChunk });
    await prisma.candidateIntelligenceSnapshot.createMany({ data: snapshotsChunk });

    console.log(`   - Writing deep PII / Identity mapping...`);
    await prisma.identityCandidate.createMany({ data: identityCandidatesChunk });
    await prisma.confirmedIdentity.createMany({ data: confirmedIdentitiesChunk });

    console.log(`   - Logging Enrichment Traces & Audit Logs...`);
    await prisma.enrichmentSession.createMany({ data: enrichmentSessionsChunk });
    await prisma.auditLog.createMany({ data: auditLogsChunk });
  }

  // Search Cache Table Mock
  console.log(`🔧 Populating Database Search Caches...`);
  await prisma.searchCacheV2.create({
    data: {
      id: crypto.randomUUID(),
      tenantId: TENANT_ID,
      queryHash: crypto.randomUUID(),
      queryText: 'site:linkedin.com/in "engineer" "san francisco"',
      parsedQuery: { keywords: ['engineer', 'san_francisco'] },
      results: [{ mock: true }],
      resultCount: 150,
      provider: 'serper',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7)
    }
  });

  console.log('✅ Deep Seed Complete! EVERY column and EVERY table is flooded with beautifully formatted data. Run npm run db:studio to see!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
