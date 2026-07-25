import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../../..');

describe('contact evidence privacy boundary', () => {
  it('does not project contact evidence into public sourcing payloads or diagnostics', () => {
    const publicFiles = [
      'src/lib/sourcing/public-memory-ingest-outbox.ts',
      'src/lib/sourcing/public-memory-ingest-worker.ts',
      'src/lib/sourcing/public-memory.ts',
      'src/lib/sourcing/queue/index.ts',
    ];
    for (const relativePath of publicFiles) {
      const source = readFileSync(
        resolve(repoRoot, relativePath),
        'utf8',
      );
      expect(source).not.toMatch(
        /selectedEmail|stagedEvidence|providerRecordId/,
      );
    }
  });

  it('does not write provider evidence into Candidate.searchMeta', () => {
    const route = readFileSync(
      resolve(
        repoRoot,
        'src/app/api/v3/candidates/[id]/find-contact/route.ts',
      ),
      'utf8',
    );
    expect(route).not.toContain('searchMeta');
    expect(route).not.toContain('FULLENRICH_API_KEY');
    expect(route).not.toContain('ENRICHLAYER_API_KEY');
  });
});
