-- CreateTable: Candidate (LinkedIn lead anchor)
CREATE TABLE "candidates" (
    "id" TEXT NOT NULL,
    "linkedinUrl" TEXT NOT NULL,
    "linkedinId" TEXT NOT NULL,
    "searchTitle" TEXT,
    "searchSnippet" TEXT,
    "nameHint" TEXT,
    "headlineHint" TEXT,
    "locationHint" TEXT,
    "roleType" TEXT,
    "captureSource" TEXT NOT NULL DEFAULT 'search',
    "searchQuery" TEXT,
    "searchProvider" TEXT,
    "enrichmentStatus" TEXT NOT NULL DEFAULT 'pending',
    "lastEnrichedAt" TIMESTAMP(3),
    "confidenceScore" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable: IdentityCandidate (unconfirmed identity signals)
CREATE TABLE "identity_candidates" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "platformId" TEXT NOT NULL,
    "profileUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unconfirmed',
    "confidence" DOUBLE PRECISION NOT NULL,
    "confidenceBucket" TEXT,
    "scoreBreakdown" JSONB,
    "evidence" JSONB,
    "hasContradiction" BOOLEAN NOT NULL DEFAULT false,
    "contradictionNote" TEXT,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "discoveredBy" TEXT,
    "searchQuery" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "identity_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ConfirmedIdentity (verified identities with PII)
CREATE TABLE "confirmed_identities" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "platformId" TEXT NOT NULL,
    "profileUrl" TEXT NOT NULL,
    "contactInfo" JSONB,
    "profileData" JSONB,
    "confirmedBy" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmationNote" TEXT,
    "identityCandidateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "confirmed_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable: EnrichmentSession (audit trail for enrichment runs)
CREATE TABLE "enrichment_sessions" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "roleType" TEXT,
    "sourcesPlanned" JSONB,
    "sourcesExecuted" JSONB,
    "queriesPlanned" INTEGER,
    "queriesExecuted" INTEGER,
    "earlyStopReason" TEXT,
    "identitiesFound" INTEGER NOT NULL DEFAULT 0,
    "identitiesConfirmed" INTEGER NOT NULL DEFAULT 0,
    "finalConfidence" DOUBLE PRECISION,
    "errorMessage" TEXT,
    "errorDetails" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enrichment_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable: AuditLog (compliance audit trail)
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable: SearchCacheV2 (DB-based search cache)
CREATE TABLE "search_cache_v2" (
    "id" TEXT NOT NULL,
    "queryHash" TEXT NOT NULL,
    "queryText" TEXT NOT NULL,
    "parsedQuery" JSONB NOT NULL,
    "results" JSONB NOT NULL,
    "resultCount" INTEGER NOT NULL,
    "provider" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_cache_v2_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: candidates
CREATE UNIQUE INDEX "candidates_linkedinUrl_key" ON "candidates"("linkedinUrl");
CREATE UNIQUE INDEX "candidates_linkedinId_key" ON "candidates"("linkedinId");
CREATE INDEX "candidates_linkedinId_idx" ON "candidates"("linkedinId");
CREATE INDEX "candidates_roleType_idx" ON "candidates"("roleType");
CREATE INDEX "candidates_enrichmentStatus_idx" ON "candidates"("enrichmentStatus");
CREATE INDEX "candidates_confidenceScore_idx" ON "candidates"("confidenceScore");
CREATE INDEX "candidates_createdAt_idx" ON "candidates"("createdAt");

-- CreateIndex: identity_candidates
CREATE UNIQUE INDEX "identity_candidates_candidateId_platform_platformId_key" ON "identity_candidates"("candidateId", "platform", "platformId");
CREATE INDEX "identity_candidates_candidateId_idx" ON "identity_candidates"("candidateId");
CREATE INDEX "identity_candidates_platform_idx" ON "identity_candidates"("platform");
CREATE INDEX "identity_candidates_status_idx" ON "identity_candidates"("status");
CREATE INDEX "identity_candidates_confidence_idx" ON "identity_candidates"("confidence");
CREATE INDEX "identity_candidates_createdAt_idx" ON "identity_candidates"("createdAt");

-- CreateIndex: confirmed_identities
CREATE UNIQUE INDEX "confirmed_identities_identityCandidateId_key" ON "confirmed_identities"("identityCandidateId");
CREATE UNIQUE INDEX "confirmed_identities_candidateId_platform_platformId_key" ON "confirmed_identities"("candidateId", "platform", "platformId");
CREATE INDEX "confirmed_identities_candidateId_idx" ON "confirmed_identities"("candidateId");
CREATE INDEX "confirmed_identities_platform_idx" ON "confirmed_identities"("platform");
CREATE INDEX "confirmed_identities_confirmedBy_idx" ON "confirmed_identities"("confirmedBy");
CREATE INDEX "confirmed_identities_createdAt_idx" ON "confirmed_identities"("createdAt");

-- CreateIndex: enrichment_sessions
CREATE INDEX "enrichment_sessions_candidateId_idx" ON "enrichment_sessions"("candidateId");
CREATE INDEX "enrichment_sessions_status_idx" ON "enrichment_sessions"("status");
CREATE INDEX "enrichment_sessions_createdAt_idx" ON "enrichment_sessions"("createdAt");

-- CreateIndex: audit_logs
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");
CREATE INDEX "audit_logs_resourceType_resourceId_idx" ON "audit_logs"("resourceType", "resourceId");
CREATE INDEX "audit_logs_actorType_actorId_idx" ON "audit_logs"("actorType", "actorId");
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex: search_cache_v2
CREATE UNIQUE INDEX "search_cache_v2_queryHash_key" ON "search_cache_v2"("queryHash");
CREATE INDEX "search_cache_v2_queryHash_idx" ON "search_cache_v2"("queryHash");
CREATE INDEX "search_cache_v2_expiresAt_idx" ON "search_cache_v2"("expiresAt");

-- AddForeignKey: identity_candidates → candidates
ALTER TABLE "identity_candidates" ADD CONSTRAINT "identity_candidates_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: confirmed_identities → candidates
ALTER TABLE "confirmed_identities" ADD CONSTRAINT "confirmed_identities_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: enrichment_sessions → candidates
ALTER TABLE "enrichment_sessions" ADD CONSTRAINT "enrichment_sessions_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
