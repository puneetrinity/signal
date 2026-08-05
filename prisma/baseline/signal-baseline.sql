-- Immutable empty-database baseline for Signal. Do not edit; regenerate through review.
BEGIN;
-- CreateTable
CREATE TABLE "people" (
    "id" TEXT NOT NULL,
    "linkedinUrl" TEXT NOT NULL,
    "linkedinId" TEXT NOT NULL,
    "linkedinNumId" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "headline" TEXT,
    "about" TEXT,
    "location" TEXT,
    "city" TEXT,
    "countryCode" TEXT,
    "profilePicUrl" TEXT,
    "bannerImage" TEXT,
    "defaultAvatar" BOOLEAN NOT NULL DEFAULT false,
    "currentCompany" TEXT,
    "currentCompanyId" TEXT,
    "experience" JSONB,
    "education" JSONB,
    "languages" JSONB,
    "connections" INTEGER,
    "followers" INTEGER,
    "searchCount" INTEGER NOT NULL DEFAULT 0,
    "lastViewed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "memorializedAccount" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "people_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "searches" (
    "id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "results" JSONB NOT NULL,
    "resultCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "searches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "researches" (
    "id" TEXT NOT NULL,
    "personId" TEXT,
    "linkedinUrl" TEXT NOT NULL,
    "personName" TEXT NOT NULL,
    "report" TEXT NOT NULL,
    "sources" JSONB NOT NULL,
    "metadata" JSONB,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "researches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "linkedinUrl" TEXT NOT NULL,
    "linkedinId" TEXT NOT NULL,
    "searchTitle" TEXT,
    "searchSnippet" TEXT,
    "searchMeta" JSONB,
    "nameHint" TEXT,
    "headlineHint" TEXT,
    "locationHint" TEXT,
    "locationConfidence" DOUBLE PRECISION,
    "locationSource" TEXT,
    "companyHint" TEXT,
    "seniorityHint" TEXT,
    "roleType" TEXT,
    "captureSource" TEXT NOT NULL DEFAULT 'search',
    "searchQuery" TEXT,
    "searchProvider" TEXT,
    "enrichmentStatus" TEXT NOT NULL DEFAULT 'pending',
    "lastEnrichedAt" TIMESTAMP(3),
    "confidenceScore" DOUBLE PRECISION,
    "profilePictureUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_intelligence_snapshots" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "track" TEXT NOT NULL DEFAULT 'tech',
    "skillsNormalized" TEXT[],
    "roleType" TEXT,
    "seniorityBand" TEXT,
    "location" TEXT,
    "locationConfidence" DOUBLE PRECISION,
    "locationSource" TEXT,
    "industries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "activityRecencyDays" INTEGER,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "staleAfter" TIMESTAMP(3) NOT NULL,
    "sourceSessionId" TEXT,
    "sourceFingerprint" TEXT,
    "signalsJson" JSONB,

    CONSTRAINT "candidate_intelligence_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_candidates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "platformId" TEXT NOT NULL,
    "profileUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unconfirmed',
    "confidence" DOUBLE PRECISION NOT NULL,
    "confidenceBucket" TEXT,
    "scoreBreakdown" JSONB,
    "bridgeTier" INTEGER,
    "bridgeSignals" JSONB,
    "persistReason" TEXT,
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

-- CreateTable
CREATE TABLE "confirmed_identities" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
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

-- CreateTable
CREATE TABLE "enrichment_sessions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
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
    "summary" TEXT,
    "summaryStructured" JSONB,
    "summaryEvidence" JSONB,
    "summaryModel" TEXT,
    "summaryTokens" INTEGER,
    "summaryGeneratedAt" TIMESTAMP(3),
    "runTrace" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enrichment_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
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

-- CreateTable
CREATE TABLE "tenant_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "rateLimitMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "maxEnrichmentsPerDay" INTEGER NOT NULL DEFAULT 100,
    "maxQueriesPerEnrichment" INTEGER NOT NULL DEFAULT 30,
    "maxParallelPlatforms" INTEGER NOT NULL DEFAULT 3,
    "features" JSONB,
    "allowContactStorage" BOOLEAN NOT NULL DEFAULT true,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "planSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_cache_v2" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
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

-- CreateTable
CREATE TABLE "candidate_global_links" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "globalCandidateId" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "linkConfidence" DOUBLE PRECISION,
    "matchMethod" TEXT,

    CONSTRAINT "candidate_global_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_enrichment_operations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "globalCandidateId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "generation" INTEGER NOT NULL DEFAULT 1,
    "provider" TEXT,
    "providerRequestKey" TEXT,
    "providerRecordId" TEXT,
    "stagedEvidence" JSONB,
    "stagedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "providerStartedAt" TIMESTAMP(3),
    "selectedEmail" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_enrichment_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_memory_ingest_outbox" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "signalCandidateId" TEXT NOT NULL,
    "sourcingRequestId" TEXT,
    "localCandidateId" TEXT,
    "payload" JSONB NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "globalCandidateId" TEXT,
    "lastErrorCode" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "linkedAt" TIMESTAMP(3),
    "linkAttempts" INTEGER NOT NULL DEFAULT 0,
    "linkNextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "linkLastErrorCode" TEXT,
    "linkDeadAt" TIMESTAMP(3),
    "payloadCompactedAt" TIMESTAMP(3),
    "diagnosticsRecordedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "public_memory_ingest_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_memory_ingest_receipts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "signalCandidateId" TEXT NOT NULL,
    "sourcingRequestId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "terminalAt" TIMESTAMP(3),
    "diagnosticsRecordedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "public_memory_ingest_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sourcing_coverage_states" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "queryFingerprint" TEXT NOT NULL,
    "activeRung" TEXT,
    "shortfallStreak" INTEGER NOT NULL DEFAULT 0,
    "lastExactProviderTotal" INTEGER,
    "lastExactRequestedLimit" INTEGER NOT NULL DEFAULT 0,
    "lastProviderTotal" INTEGER,
    "lastRequestedLimit" INTEGER NOT NULL DEFAULT 0,
    "lastRawReturnedCount" INTEGER NOT NULL DEFAULT 0,
    "lastSpillObservedAt" TIMESTAMP(3),
    "lastSubmittedExclusionCount" INTEGER NOT NULL DEFAULT 0,
    "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sourcing_coverage_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_sourcing_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "externalJobId" TEXT NOT NULL,
    "jobContextHash" TEXT NOT NULL,
    "jobContext" JSONB NOT NULL,
    "callbackUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "callbackAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastCallbackError" TEXT,
    "callback_status" TEXT,
    "callback_sent_at" TIMESTAMPTZ(6),
    "resultCount" INTEGER,
    "quality_gate_triggered" BOOLEAN NOT NULL DEFAULT false,
    "queries_executed" INTEGER NOT NULL DEFAULT 0,
    "diagnostics" JSONB,
    "last_reranked_at" TIMESTAMPTZ(6),
    "acquisition_generation" INTEGER NOT NULL DEFAULT 1,
    "execution_attempt_id" TEXT,
    "processing_lease_id" TEXT,

    CONSTRAINT "job_sourcing_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crustdata_acquisition_receipts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourcingRequestId" TEXT NOT NULL,
    "acquisitionGeneration" INTEGER NOT NULL,
    "slot" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'started',
    "requestFingerprint" TEXT NOT NULL,
    "requestInput" JSONB NOT NULL,
    "requestMetadata" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "effectsAppliedAt" TIMESTAMP(3),
    "effectMetadata" JSONB,
    "memory_ingested_at" TIMESTAMP(3),
    "memory_ingest_metadata" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crustdata_acquisition_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_sourcing_candidates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourcingRequestId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "fitScore" DOUBLE PRECISION,
    "fitBreakdown" JSONB,
    "sourceType" TEXT NOT NULL,
    "enrichmentStatus" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,

    CONSTRAINT "job_sourcing_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "people_linkedinUrl_key" ON "people"("linkedinUrl");

-- CreateIndex
CREATE UNIQUE INDEX "people_linkedinId_key" ON "people"("linkedinId");

-- CreateIndex
CREATE INDEX "people_fullName_idx" ON "people"("fullName");

-- CreateIndex
CREATE INDEX "people_firstName_lastName_idx" ON "people"("firstName", "lastName");

-- CreateIndex
CREATE INDEX "people_lastViewed_idx" ON "people"("lastViewed");

-- CreateIndex
CREATE INDEX "people_linkedinId_idx" ON "people"("linkedinId");

-- CreateIndex
CREATE INDEX "people_currentCompany_idx" ON "people"("currentCompany");

-- CreateIndex
CREATE INDEX "people_location_idx" ON "people"("location");

-- CreateIndex
CREATE INDEX "people_updatedAt_idx" ON "people"("updatedAt");

-- CreateIndex
CREATE INDEX "searches_query_idx" ON "searches"("query");

-- CreateIndex
CREATE INDEX "researches_personId_idx" ON "researches"("personId");

-- CreateIndex
CREATE INDEX "researches_linkedinUrl_idx" ON "researches"("linkedinUrl");

-- CreateIndex
CREATE INDEX "researches_status_idx" ON "researches"("status");

-- CreateIndex
CREATE INDEX "researches_createdAt_idx" ON "researches"("createdAt");

-- CreateIndex
CREATE INDEX "candidates_tenantId_idx" ON "candidates"("tenantId");

-- CreateIndex
CREATE INDEX "candidates_tenantId_linkedinId_idx" ON "candidates"("tenantId", "linkedinId");

-- CreateIndex
CREATE INDEX "candidates_linkedinId_idx" ON "candidates"("linkedinId");

-- CreateIndex
CREATE INDEX "candidates_roleType_idx" ON "candidates"("roleType");

-- CreateIndex
CREATE INDEX "candidates_enrichmentStatus_idx" ON "candidates"("enrichmentStatus");

-- CreateIndex
CREATE INDEX "candidates_confidenceScore_idx" ON "candidates"("confidenceScore");

-- CreateIndex
CREATE INDEX "candidates_createdAt_idx" ON "candidates"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_tenantId_id_key" ON "candidates"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_tenantId_linkedinUrl_key" ON "candidates"("tenantId", "linkedinUrl");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_tenantId_linkedinId_key" ON "candidates"("tenantId", "linkedinId");

-- CreateIndex
CREATE INDEX "candidate_intelligence_snapshots_tenantId_track_idx" ON "candidate_intelligence_snapshots"("tenantId", "track");

-- CreateIndex
CREATE INDEX "candidate_intelligence_snapshots_tenantId_staleAfter_idx" ON "candidate_intelligence_snapshots"("tenantId", "staleAfter");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_intelligence_snapshots_candidateId_tenantId_track_key" ON "candidate_intelligence_snapshots"("candidateId", "tenantId", "track");

-- CreateIndex
CREATE INDEX "identity_candidates_tenantId_idx" ON "identity_candidates"("tenantId");

-- CreateIndex
CREATE INDEX "identity_candidates_candidateId_idx" ON "identity_candidates"("candidateId");

-- CreateIndex
CREATE INDEX "identity_candidates_platform_idx" ON "identity_candidates"("platform");

-- CreateIndex
CREATE INDEX "identity_candidates_status_idx" ON "identity_candidates"("status");

-- CreateIndex
CREATE INDEX "identity_candidates_confidence_idx" ON "identity_candidates"("confidence");

-- CreateIndex
CREATE INDEX "identity_candidates_bridgeTier_idx" ON "identity_candidates"("bridgeTier");

-- CreateIndex
CREATE INDEX "identity_candidates_createdAt_idx" ON "identity_candidates"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "identity_candidates_candidateId_platform_platformId_key" ON "identity_candidates"("candidateId", "platform", "platformId");

-- CreateIndex
CREATE UNIQUE INDEX "identity_candidates_tenantId_candidateId_platform_platformId_ke" ON "identity_candidates"("tenantId", "candidateId", "platform", "platformId");

-- CreateIndex
CREATE INDEX "confirmed_identities_tenantId_idx" ON "confirmed_identities"("tenantId");

-- CreateIndex
CREATE INDEX "confirmed_identities_candidateId_idx" ON "confirmed_identities"("candidateId");

-- CreateIndex
CREATE INDEX "confirmed_identities_platform_idx" ON "confirmed_identities"("platform");

-- CreateIndex
CREATE INDEX "confirmed_identities_confirmedBy_idx" ON "confirmed_identities"("confirmedBy");

-- CreateIndex
CREATE INDEX "confirmed_identities_createdAt_idx" ON "confirmed_identities"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "confirmed_identities_candidateId_platform_platformId_key" ON "confirmed_identities"("candidateId", "platform", "platformId");

-- CreateIndex
CREATE UNIQUE INDEX "confirmed_identities_identityCandidateId_key" ON "confirmed_identities"("identityCandidateId");

-- CreateIndex
CREATE UNIQUE INDEX "confirmed_identities_tenantId_candidateId_platform_platformId_k" ON "confirmed_identities"("tenantId", "candidateId", "platform", "platformId");

-- CreateIndex
CREATE UNIQUE INDEX "confirmed_identities_tenantId_identityCandidateId_key" ON "confirmed_identities"("tenantId", "identityCandidateId");

-- CreateIndex
CREATE INDEX "enrichment_sessions_tenantId_idx" ON "enrichment_sessions"("tenantId");

-- CreateIndex
CREATE INDEX "enrichment_sessions_candidateId_idx" ON "enrichment_sessions"("candidateId");

-- CreateIndex
CREATE INDEX "enrichment_sessions_status_idx" ON "enrichment_sessions"("status");

-- CreateIndex
CREATE INDEX "enrichment_sessions_createdAt_idx" ON "enrichment_sessions"("createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_idx" ON "audit_logs"("tenantId");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_resourceType_resourceId_idx" ON "audit_logs"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "audit_logs_actorType_actorId_idx" ON "audit_logs"("actorType", "actorId");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_settings_tenantId_key" ON "tenant_settings"("tenantId");

-- CreateIndex
CREATE INDEX "tenant_settings_tenantId_idx" ON "tenant_settings"("tenantId");

-- CreateIndex
CREATE INDEX "tenant_settings_plan_idx" ON "tenant_settings"("plan");

-- CreateIndex
CREATE INDEX "search_cache_v2_tenantId_idx" ON "search_cache_v2"("tenantId");

-- CreateIndex
CREATE INDEX "search_cache_v2_tenantId_queryHash_idx" ON "search_cache_v2"("tenantId", "queryHash");

-- CreateIndex
CREATE INDEX "search_cache_v2_queryHash_idx" ON "search_cache_v2"("queryHash");

-- CreateIndex
CREATE INDEX "search_cache_v2_expiresAt_idx" ON "search_cache_v2"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "search_cache_v2_tenantId_queryHash_key" ON "search_cache_v2"("tenantId", "queryHash");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_global_links_candidateId_key" ON "candidate_global_links"("candidateId");

-- CreateIndex
CREATE INDEX "candidate_global_links_globalCandidateId_idx" ON "candidate_global_links"("globalCandidateId");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_global_links_tenantId_candidateId_key" ON "candidate_global_links"("tenantId", "candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_global_links_tenantId_globalCandidateId_key" ON "candidate_global_links"("tenantId", "globalCandidateId");

-- CreateIndex
CREATE INDEX "contact_enrichment_operations_state_nextAttemptAt_idx" ON "contact_enrichment_operations"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "contact_enrichment_operations_leaseExpiresAt_idx" ON "contact_enrichment_operations"("leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "contact_enrichment_operations_tenantId_candidateId_key" ON "contact_enrichment_operations"("tenantId", "candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "contact_enrichment_operations_tenantId_globalCandidateId_key" ON "contact_enrichment_operations"("tenantId", "globalCandidateId");

-- CreateIndex
CREATE INDEX "public_memory_ingest_outbox_status_nextAttemptAt_idx" ON "public_memory_ingest_outbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "public_memory_ingest_outbox_sourcingRequestId_status_idx" ON "public_memory_ingest_outbox"("sourcingRequestId", "status");

-- CreateIndex
CREATE INDEX "public_memory_ingest_outbox_leaseExpiresAt_idx" ON "public_memory_ingest_outbox"("leaseExpiresAt");

-- CreateIndex
CREATE INDEX "public_memory_ingest_outbox_linkNextAttemptAt_idx" ON "public_memory_ingest_outbox"("linkNextAttemptAt");

-- CreateIndex
CREATE INDEX "public_memory_ingest_outbox_status_payloadCompactedAt_idx" ON "public_memory_ingest_outbox"("status", "payloadCompactedAt");

-- CreateIndex
CREATE UNIQUE INDEX "public_memory_ingest_outbox_tenantId_signalCandidateId_key" ON "public_memory_ingest_outbox"("tenantId", "signalCandidateId");

-- CreateIndex
CREATE INDEX "public_memory_ingest_receipts_tenantId_signalCandidateId_idx" ON "public_memory_ingest_receipts"("tenantId", "signalCandidateId");

-- CreateIndex
CREATE INDEX "public_memory_ingest_receipts_sourcingRequestId_status_idx" ON "public_memory_ingest_receipts"("sourcingRequestId", "status");

-- CreateIndex
CREATE INDEX "public_memory_ingest_receipts_diagnosticsRecordedAt_created_idx" ON "public_memory_ingest_receipts"("diagnosticsRecordedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "public_memory_ingest_receipts_sourcingRequestId_signalCandi_key" ON "public_memory_ingest_receipts"("sourcingRequestId", "signalCandidateId");

-- CreateIndex
CREATE INDEX "sourcing_coverage_states_scope_scopeKey_queryFingerprint_lastOb" ON "sourcing_coverage_states"("scope", "scopeKey", "queryFingerprint", "lastObservedAt");

-- CreateIndex
CREATE UNIQUE INDEX "sourcing_coverage_states_scope_scopeKey_queryFingerprint_key" ON "sourcing_coverage_states"("scope", "scopeKey", "queryFingerprint");

-- CreateIndex
CREATE INDEX "job_sourcing_requests_tenantId_status_idx" ON "job_sourcing_requests"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "job_sourcing_requests_tenantId_externalJobId_jobContextHash_key" ON "job_sourcing_requests"("tenantId", "externalJobId", "jobContextHash");

-- CreateIndex
CREATE UNIQUE INDEX "job_sourcing_requests_id_tenantId_key" ON "job_sourcing_requests"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "crustdata_receipts_request_generation_slot_key" ON "crustdata_acquisition_receipts"("tenantId", "sourcingRequestId", "acquisitionGeneration", "slot");

-- CreateIndex
CREATE INDEX "job_sourcing_candidates_tenantId_sourcingRequestId_idx" ON "job_sourcing_candidates"("tenantId", "sourcingRequestId");

-- CreateIndex
CREATE INDEX "job_sourcing_candidates_sourcingRequestId_idx" ON "job_sourcing_candidates"("sourcingRequestId");

-- CreateIndex
CREATE INDEX "job_sourcing_candidates_candidateId_idx" ON "job_sourcing_candidates"("candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "job_sourcing_candidates_sourcingRequestId_candidateId_key" ON "job_sourcing_candidates"("sourcingRequestId", "candidateId");

-- AddForeignKey
ALTER TABLE "researches" ADD CONSTRAINT "researches_personId_fkey" FOREIGN KEY ("personId") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_intelligence_snapshots" ADD CONSTRAINT "candidate_intelligence_snapshots_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_candidates" ADD CONSTRAINT "identity_candidates_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "confirmed_identities" ADD CONSTRAINT "confirmed_identities_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichment_sessions" ADD CONSTRAINT "enrichment_sessions_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_global_links" ADD CONSTRAINT "candidate_global_links_tenantId_candidateId_fkey" FOREIGN KEY ("tenantId", "candidateId") REFERENCES "candidates"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_enrichment_operations" ADD CONSTRAINT "contact_enrichment_operations_tenantId_candidateId_fkey" FOREIGN KEY ("tenantId", "candidateId") REFERENCES "candidates"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crustdata_acquisition_receipts" ADD CONSTRAINT "crustdata_acquisition_receipts_sourcingRequestId_tenantId_fkey" FOREIGN KEY ("sourcingRequestId", "tenantId") REFERENCES "job_sourcing_requests"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_sourcing_candidates" ADD CONSTRAINT "job_sourcing_candidates_sourcingRequestId_fkey" FOREIGN KEY ("sourcingRequestId") REFERENCES "job_sourcing_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_sourcing_candidates" ADD CONSTRAINT "job_sourcing_candidates_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
COMMIT;
