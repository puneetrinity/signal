# Ealana Discover service

Discover is an internal sourcing and ranking service used by Ealana Flow. It is not a standalone recruiter-facing
browser product.

## Supported runtime surfaces

- `/api/v3/jobs/{externalJobId}/source`
- `/api/v3/jobs/{externalJobId}/results`
- `/api/v3/candidates/{externalCandidateId}/find-contact`
- the remaining scoped `/api/v3/...` service contracts
- `/api/webhooks/fullenrich`
- `/api/health`
- the sourcing worker (`npm run worker:sourcing`)

The v3 routes authenticate signed service JWTs and enforce route-specific scopes. Flow owns recruiter sessions,
organization authorization, workflow state and presentation.

## Retired surfaces

The former Clerk-backed standalone browser and its v2 search/review/session APIs are retired. Their bounded
compatibility tombstones return HTTP 410 without database, cache, queue or provider work. Do not add a browser,
Clerk configuration or direct recruiter caller back to this service.

Legacy database rows are retained until a separately approved data-retention migration; route retirement does not
delete data.

## Local checks

```bash
npm install
npm run typecheck
npm test
npm run build
```

PostgreSQL integration tests require their explicit opt-in command and disposable database described in
`package.json`; they are not part of the default unit-test run.
