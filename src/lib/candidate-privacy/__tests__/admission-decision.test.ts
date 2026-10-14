import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CandidatePrivacyMemoryClient } from '../memory-client';
import type { CandidatePrivacyDecision } from '../models';

vi.mock('../config', () => ({ isCandidatePrivacyDisposableTestAdapter: () => false }));
vi.mock('../repository', () => ({
  requireHealthyCandidatePrivacyContext: vi.fn(async () => ({ generation: BigInt(1), cursor: BigInt(7) })),
  CandidatePrivacyAdmissionProof: { issue: (value: unknown) => value },
  CandidatePrivacyUnavailableError: class extends Error {},
  CandidatePrivacyRestrictedError: class extends Error {},
}));
vi.mock('../memory-client', () => ({ HttpCandidatePrivacyMemoryClient: class {} }));
import { createCandidateAdmissionProofs } from '../decision';
import { requireHealthyCandidatePrivacyContext } from '../repository';

const anchors = (count: number) => Array.from({ length: count }, (_, i) => ({
  key: `candidate-${i}`, signalCandidateId: `candidate-${i}`,
}));
function client(): CandidatePrivacyMemoryClient {
  return {
    readHighWater: vi.fn(async () => 7),
    readChanges: vi.fn(),
    eligibilityBatch: vi.fn(async (subjects: Parameters<CandidatePrivacyMemoryClient['eligibilityBatch']>[0]) => new Map(subjects.map((s) => [s.request_ref, 'allow' as const]))),
  };
}
beforeEach(() => vi.clearAllMocks());
describe('complete privacy admission response', () => {
  it('does not grant proofs or start another batch after the retrieval deadline',async()=>{
    const api=client();let now=0;const clock=vi.spyOn(Date,'now').mockImplementation(()=>now);
    try{
      vi.mocked(api.eligibilityBatch).mockImplementation(async subjects=>{
        now=11;return new Map(subjects.map(s=>[s.request_ref,'allow' as const]));
      });
      await expect(createCandidateAdmissionProofs(anchors(201),api,10)).rejects.toThrow('candidate_privacy_unavailable');
      expect(api.eligibilityBatch).toHaveBeenCalledTimes(1);
      expect(api.readHighWater).toHaveBeenCalledTimes(1);
      await expect(createCandidateAdmissionProofs(anchors(1),api,10)).rejects.toThrow('candidate_privacy_unavailable');
      expect(api.readHighWater).toHaveBeenCalledTimes(1);
    }finally{clock.mockRestore();}
  });
  it('filters only known restrictions across the entire batched response', async () => {
    const api = client();
    vi.mocked(api.eligibilityBatch).mockImplementation(async subjects => new Map(
      subjects.map((s, i) => [s.request_ref, (i === 0 ? 'block_all' : 'allow') as CandidatePrivacyDecision]),
    ));
    const proofs = await createCandidateAdmissionProofs(anchors(201), api);
    expect(proofs.size).toBe(199);
    expect(proofs.has('candidate-0')).toBe(false);
    expect(proofs.has('candidate-200')).toBe(false);
    expect(proofs.has('candidate-199')).toBe(true);
    expect(api.readHighWater).toHaveBeenCalledTimes(2);
    expect(requireHealthyCandidatePrivacyContext).toHaveBeenCalledTimes(1);
  });
  it.each(['block_all', 'block_global', 'review'] as const)('excludes %s without losing allowed people', async decision => {
    const api = client();
    vi.mocked(api.eligibilityBatch).mockImplementation(async subjects => new Map([
      [subjects[0].request_ref, decision], [subjects[1].request_ref, 'allow'],
    ]));
    expect([...await createCandidateAdmissionProofs(anchors(2), api)].map(([key]) => key)).toEqual(['candidate-1']);
  });
  it.each(['missing', 'extra', 'substituted', 'unknown'] as const)('refuses %s decisions', async kind => {
    const api = client();
    vi.mocked(api.eligibilityBatch).mockImplementation(async subjects => {
      const answer = new Map<string, CandidatePrivacyDecision>(subjects.map(s => [s.request_ref, 'allow']));
      if (kind === 'missing' || kind === 'substituted') answer.delete(subjects[0].request_ref);
      if (kind === 'extra' || kind === 'substituted') answer.set('unexpected-ref', 'allow');
      if (kind === 'unknown') answer.set(subjects[0].request_ref, 'unexpected' as CandidatePrivacyDecision);
      return answer;
    });
    await expect(createCandidateAdmissionProofs(anchors(2), api)).rejects.toThrow('candidate_privacy_conflict');
  });
  it('rejects duplicate input keys before consulting Memory', async () => {
    const api = client();
    await expect(createCandidateAdmissionProofs([...anchors(1), ...anchors(1)], api)).rejects.toThrow('candidate_privacy_conflict');
    expect(api.eligibilityBatch).not.toHaveBeenCalled();
  });
  it('rejects a generation cursor change after the last batch', async () => {
    const api = client();
    vi.mocked(api.readHighWater).mockResolvedValueOnce(7).mockResolvedValueOnce(8);
    await expect(createCandidateAdmissionProofs(anchors(201), api)).rejects.toThrow('candidate_privacy_conflict');
  });
});
