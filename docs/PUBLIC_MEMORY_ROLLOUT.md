# Public Memory Rollout

Public Memory shares only the Crustdata-derived projection. Tenant applicants,
uploads, resumes, notes, recruiting activity, and contact evidence remain
outside this surface.

Deploy and enable in this order:

1. Deploy Memory migration 021 with
   `GLOBAL_PUBLIC_PROFILE_SEARCH_ENABLED=false` and
   `GLOBAL_LEGACY_CANDIDATE_SEARCH_ENABLED=true`.
2. Keep Signal's strict public ingest outbox worker running. Wait for the
   public embedding v1 queue to drain, then verify the public/private isolation
   suite and the public retrieval recall gate.
3. Switch Memory atomically to
   `GLOBAL_PUBLIC_PROFILE_SEARCH_ENABLED=true` and
   `GLOBAL_LEGACY_CANDIDATE_SEARCH_ENABLED=false`. Readiness intentionally
   rejects a build where both surfaces are active.
4. Deploy Signal with both
   `SOURCE_PUBLIC_MEMORY_HYDRATION_ENABLED=false` and
   `SOURCE_PLATFORM_EXCLUSION_ENABLED=false`.
5. Enable public hydration first. Verify `publicMemory.searchSurface` is
   `public_v1`, public identities hydrate successfully, and no tenant-private
   fields cross organisations.
6. Enable platform exclusion only after hydration succeeds in production.
   Signal also enforces this ordering per run: exclusion fails open unless the
   same run has a working public hydration surface.

Rollback by disabling Signal's platform exclusion and public hydration before
switching Memory back to the legacy surface. Contact evidence is a separate,
tenant-scoped rollout; cross-organisation contact reuse remains disabled until
provider terms explicitly permit it.
