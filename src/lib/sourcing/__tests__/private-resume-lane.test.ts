import {describe,it,expect,vi,afterEach} from 'vitest';
import {readResumeLane,revalidateResumeIdentities,type ResumeLaneContext,type ResumeLaneDependencies} from '../private-resume-lane';
import type {PrivateResumeIdentity} from '../private-resume-contracts';
const context={tenantId:'org_32',requestId:'request',executionAttemptId:'execution',command:{
 protocolVersion:2,organizationRef:'32',externalJobId:'vanta:jobs:189',flowRunId:'run',briefVersionId:'brief',
 callbackUrl:'https://flow.invalid/api/webhooks/signal/callback',artifactHash:'a'.repeat(64),
 rankingContract:{payload:{schemaVersion:4}},queryArtifact:{jobContext:{title:'Engineer',location:'India',skills:['Python'],goodToHaveSkills:[]}},
}} as unknown as ResumeLaneContext;
const identities=[{candidateId:'one'},{candidateId:'two'}] as PrivateResumeIdentity[];
function deps() {
 return {read:vi.fn().mockResolvedValue({results:[]}),
  revalidate:vi.fn().mockResolvedValue({results:[{decision:'allow'},{decision:'same_job'}]}),
  flow:vi.fn().mockResolvedValue({results:[{decision:'allow'}]})};
}
describe('managed resume search lane authority',()=>{
 afterEach(()=>vi.useRealTimers());
 it('checks Memory then Flow and uses the same deadline for both',async()=>{
  const d=deps(),deadline=Date.now()+9000;
  expect(await revalidateResumeIdentities(context,identities,deadline,d as ResumeLaneDependencies)).toEqual([identities[0]]);
  expect(d.flow.mock.calls[0]![2].items).toHaveLength(1);
  expect(d.flow.mock.calls[0]![3].deadlineAt).toBe(deadline);
  expect(d.revalidate.mock.calls[0]![2].deadlineAt).toBe(deadline);
 });
 it('does not turn unavailable authority into an empty fallback',async()=>{
  const d=deps();d.revalidate.mockResolvedValue({results:[{decision:'unavailable'}]});
  await expect(revalidateResumeIdentities(context,identities,Date.now()+9000,d as ResumeLaneDependencies)).rejects.toThrow('UNAVAILABLE');
  expect(d.flow).not.toHaveBeenCalled();
 });
 it('applies a late same-job decision',async()=>{
  const d=deps();d.flow.mockResolvedValue({results:[{decision:'same_job'}]});
  expect(await revalidateResumeIdentities(context,identities,Date.now()+9000,d as ResumeLaneDependencies)).toEqual([]);
 });
 it.each([{tenantId:'org_5'},{command:{...context.command,externalJobId:'189'}},
  {command:{...context.command,rankingContract:{payload:{schemaVersion:3}}}}])('rejects wrong authority before reading',async patch=>{
  const d=deps();await expect(readResumeLane({...context,...patch} as ResumeLaneContext,Date.now()+9000,d as ResumeLaneDependencies)).rejects.toThrow('AUTHORITY');
  expect(d.read).not.toHaveBeenCalled();
 });
 it('makes no call after the common deadline',async()=>{
  const d=deps();await expect(readResumeLane(context,Date.now()-1,d as ResumeLaneDependencies)).rejects.toThrow('UNAVAILABLE');
  expect(d.read).not.toHaveBeenCalled();
 });
});
