import { describe, expect, it, vi } from 'vitest';
import { requirePublicContactCandidate } from '../private-candidate-access';
const check=vi.hoisted(()=>vi.fn().mockResolvedValue({results:[{isApplicant:false}]}));
vi.mock('../private-resume-client',()=>({checkPublicApplicants:check}));

const row = {allowed:true};
describe('stored contact eligibility', () => {
  it('queries the authenticated tenant and candidate', async () => {
    const $queryRaw = vi.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce([{publicId:'11111111-1111-4111-8111-111111111111'}]);
    await expect(requirePublicContactCandidate('org_2', 'c1', { $queryRaw })).resolves.toBeUndefined();
    expect($queryRaw.mock.calls[0].slice(1)).toEqual(['org_2', 'c1']);
  });
  it('refuses a past applicant even before any private search has materialized them',async()=>{
    check.mockResolvedValueOnce({results:[{isApplicant:true}]});
    const $queryRaw=vi.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce([{publicId:'11111111-1111-4111-8111-111111111111'}]);
    await expect(requirePublicContactCandidate('org_2','c1',{$queryRaw})).rejects.toThrow('ineligible');
  });
  it('refuses absent verified public linkage at strict dispatch',async()=>{
    const $queryRaw=vi.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
    await expect(requirePublicContactCandidate('org_2','c1',{$queryRaw})).rejects.toThrow('ineligible');
  });
  it('allows an SQL-approved public candidate to wait for graph sync at admission',async()=>{
    check.mockClear();
    const $queryRaw=vi.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
    await expect(requirePublicContactCandidate('org_2','c1',{$queryRaw},{allowUnlinked:true})).resolves.toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });
  it.each([[{publicId:'bad'}],[{publicId:'11111111-1111-4111-8111-111111111111'},{publicId:'22222222-2222-4222-8222-222222222222'}]].map(links=>[links]))('never waits through malformed or duplicate linkage',async links=>{
    const $queryRaw=vi.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce(links);
    await expect(requirePublicContactCandidate('org_2','c1',{$queryRaw},{allowUnlinked:true})).rejects.toThrow('ineligible');
  });
  it.each([[], [{allowed:false}], [{allowed:null}], [{allowed:'true'}], [{}], [row, row]].map(rows => [rows]))(
    'refuses absent, linked private, null or duplicate authority %j', async (rows) => {
      await expect(requirePublicContactCandidate('org_2', 'c1', { $queryRaw: vi.fn().mockResolvedValue(rows) }))
        .rejects.toThrow('candidate_contact_ineligible');
    });
});
