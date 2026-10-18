import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { fusePrivateResumes } from '../private-resume-fusion';
import { materializePrivateResume } from '../private-resume-materialization';
import type { PrivateResumeHit } from '../private-resume-contracts';

const hit = (): PrivateResumeHit => ({
  identity: { candidateId: randomUUID(), referenceId: randomUUID(), applicationId: 123,
    applicationJobId: 188, resumeVersionId: randomUUID(), sourceId: randomUUID(),
    generationId: randomUUID(), sourceHash: 'a'.repeat(64) },
  linkedPublicId: null, distance: 0.2,
  evidence: { version: 1, kind: 'candidate_provided', scope: 'org_32', sourceVersion: 1,
    observedAt: '2026-10-18T00:00:00Z', skills: ['Python'],
    location: { city: null, country: null }, currentTitle: null, seniority: null,
    primaryTitles: [], domains: [], functions: [], certifications: [], industries: [] },
});

describe('bounded private retrieval fusion', () => {
  it('preserves the legacy order when no managed resumes exist', () => {
    const rows = ['z', 'a', 'm'].map(candidateId => ({ candidateId, globalCandidateId: null, value: candidateId }));
    expect(fusePrivateResumes('org_32', [], rows, 300).map(x => x.kind === 'legacy' && x.legacy))
      .toEqual(['z', 'a', 'm']);
  });
  it('combines authoritative linked identities into one private result', () => {
    const resume = { ...hit(), linkedPublicId: randomUUID() };
    const result = fusePrivateResumes('org_32', [resume], [
      { candidateId: 'public-local-id', globalCandidateId: resume.linkedPublicId, value: 'public' },
    ], 300);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'managed', resume });
  });
  it('does not join unrelated candidates, even with identical professional facts', () => {
    expect(fusePrivateResumes('org_32', [hit(), hit()], [], 300)).toHaveLength(2);
  });
  it('refuses duplicate identities rather than artificially increasing their score', () => {
    const resume = hit();
    expect(() => fusePrivateResumes('org_32', [resume, resume], [], 300)).toThrow('DUPLICATE');
    expect(() => fusePrivateResumes('org_32', [], [
      { candidateId: 'a', globalCandidateId: null, value: 1 },
      { candidateId: 'a', globalCandidateId: null, value: 2 },
    ], 300)).toThrow('DUPLICATE');
  });
  it('checks organisation and result bounds before merging', () => {
    expect(() => fusePrivateResumes('org_5', [hit()], [], 300)).toThrow('TENANT');
    for (const limit of [0, 301, 1.5]) expect(() => fusePrivateResumes('org_32', [], [], limit)).toThrow('BOUNDS');
    expect(() => fusePrivateResumes('org_32', Array.from({ length: 101 }, hit), [], 300)).toThrow('BOUNDS');
  });
  it('uses a deterministic byte-order tie break without changing either lane priority', () => {
    const resume = hit();
    resume.identity.candidateId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const rows = [{ candidateId: '000-first', globalCandidateId: null, value: 'legacy' }];
    expect(fusePrivateResumes('org_32', [resume], rows, 1)[0].kind).toBe('legacy');
  });
  it('fills the 300 cap with both lanes and preserves the leading legacy results', () => {
    const managed=Array.from({length:100},hit);
    const legacy=Array.from({length:300},(_,index)=>({candidateId:`legacy-${index}`,
      globalCandidateId:null,value:index}));
    const result=fusePrivateResumes('org_32',managed,legacy,300);
    expect(result).toHaveLength(300);
    expect(new Set(result.map(item=>item.key)).size).toBe(300);
    expect(result.filter(item=>item.kind==='managed')).toHaveLength(100);
    expect(result.flatMap(item=>item.kind==='legacy'?[item.legacy]:[])).toEqual(
      Array.from({length:200},(_,index)=>index));
    expect(fusePrivateResumes('org_32',[],legacy,300).map(item=>item.kind==='legacy'&&item.legacy))
      .toEqual(Array.from({length:300},(_,index)=>index));
  });
});

describe('private materialization boundary', () => {
  it('passes provenance only to the fixed database routine, never resume facts', async () => {
    const query = vi.fn().mockResolvedValue([{ id: 'local-candidate' }]);
    const resume = hit();
    expect(await materializePrivateResume({ $queryRaw: query }, 'org_32', resume)).toBe('local-candidate');
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, tenant, payload] = query.mock.calls[0];
    expect(sql.join('?')).toContain('signal_private_candidate_materialize');
    expect(tenant).toBe('org_32');
    expect(JSON.parse(payload)).toEqual({ identity: resume.identity, linkedPublicId: null,
      observedAt: resume.evidence.observedAt });
    expect(payload).not.toContain('Python');
  });
  it('does not call the database for foreign evidence', async () => {
    const query = vi.fn();
    await expect(materializePrivateResume({ $queryRaw: query }, 'org_5', hit())).rejects.toThrow('TENANT');
    expect(query).not.toHaveBeenCalled();
  });
  it.each([[], [null], [{ id: null }], [{ id: '' }], [{ id: 'a' }, { id: 'b' }]].map(rows => ({ rows })))
  ('rejects malformed database outcomes', async ({ rows }) => {
    await expect(materializePrivateResume({ $queryRaw: vi.fn().mockResolvedValue(rows) }, 'org_32', hit()))
      .rejects.toThrow('UNAVAILABLE');
  });
});
