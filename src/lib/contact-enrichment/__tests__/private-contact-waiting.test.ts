import {beforeEach,describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
import type {ClaimedContactOperation} from '../types';
import type {ContactOperationStore} from '../store';

// Mock only I/O boundaries. The route, worker and public/applicant eligibility
// implementation are real, including its SQL-result and linkage decisions.
const io=vi.hoisted(()=>({query:vi.fn(),membership:vi.fn(),operation:vi.fn(),lookup:vi.fn()}));
vi.mock('@/lib/prisma',()=>({prisma:{$queryRaw:io.query}}));
vi.mock('@/lib/sourcing/private-resume-client',()=>({checkPublicApplicants:io.membership}));
vi.mock('@/lib/candidate-privacy/repository',()=>({requireCandidatePrivacyAllowed:vi.fn().mockResolvedValue({})}));
vi.mock('@/lib/auth/service-jwt',()=>({verifyServiceJWT:vi.fn().mockResolvedValue({authorized:true,
  context:{tenantId:'org_1',sub:'flow',actorType:'service',scopes:['contact:write'],jti:'local'}})}));
vi.mock('../store',()=>({PrismaContactOperationStore:class {},findOrCreateContactOperation:io.operation,
  candidateAppearedInSourcingJob:vi.fn().mockResolvedValue(true),applyContactMemoryRevalidation:vi.fn()}));
vi.mock('../memory-client',()=>({ActiveGraphContactMemoryClient:class{lookup=io.lookup;},
  MemoryContactUnavailableError:class extends Error{}}));
import {runContactEnrichmentCycle} from '../worker';
import {POST} from '@/app/api/v3/candidates/[id]/find-contact/route';

const ID='11111111-1111-4111-8111-111111111111';
const NOW=new Date('2026-10-18T00:00:00Z');
function fixture(){
  const row:ClaimedContactOperation={id:'operation',tenantId:'org_1',candidateId:'candidate',
    globalCandidateId:null,linkedGlobalCandidateId:null,state:'queued',generation:1,provider:null,
    providerRequestKey:null,providerRecordId:null,stagedEvidence:null,stagedAt:null,attempts:1,
    nextAttemptAt:NOW,leaseToken:'lease',leaseExpiresAt:new Date(NOW.getTime()+60000),
    lastErrorCode:null,providerStartedAt:null,selectedEmail:null,completedAt:null,createdAt:NOW,updatedAt:NOW,
    linkedinUrl:'https://www.linkedin.com/in/synthetic',nameHint:'Synthetic',companyHint:null};
  const store:ContactOperationStore={claim:async()=>[{...row}],transition:async({expectedStates,transition})=>{
    if(!expectedStates.includes(row.state))return false;Object.assign(row,transition);return true;
  }};
  const memory={lookup:vi.fn().mockResolvedValue({state:'miss'}),record:vi.fn()};
  const providers={startFullEnrich:vi.fn().mockResolvedValue({kind:'started',providerRecordId:'synthetic'}),
    pollFullEnrich:vi.fn(),callEnrichLayer:vi.fn()};
  const cycle=()=>runContactEnrichmentCycle({store,memory,providers,now:()=>NOW,linkRetryMs:0,retryMs:0});
  return {row,memory,providers,cycle};
}
let links:Array<{publicId:string}>;
let allowed:boolean;
describe('real applicant eligibility with delayed public graph sync',()=>{
  beforeEach(()=>{
    vi.clearAllMocks();links=[];allowed=true;
    io.membership.mockResolvedValue({results:[{isApplicant:false}]});
    io.query.mockImplementation(async(strings:TemplateStringsArray)=>strings.join('').includes('signal_private_contact_allowed')?[{allowed}]:links);
  });
  it('route queues an unlinked public candidate rather than refusing it',async()=>{
    io.operation.mockResolvedValue(fixture().row);
    const response=await POST(new NextRequest('https://local.invalid/api/v3/candidates/candidate/find-contact',
      {method:'POST',body:JSON.stringify({trigger:'shortlist',jobId:'job'})}),{params:Promise.resolve({id:'candidate'})});
    expect(response.status).toBe(202);expect(io.operation).toHaveBeenCalledOnce();
    expect(io.membership).not.toHaveBeenCalled();expect(io.lookup).not.toHaveBeenCalled();
  });
  it('waits without spend, then checks membership and dispatches after linkage',async()=>{
    const f=fixture();await f.cycle();
    expect(f.row.state).toBe('awaiting_global_id');expect(f.memory.lookup).not.toHaveBeenCalled();
    expect(io.membership).not.toHaveBeenCalled();expect(f.providers.startFullEnrich).not.toHaveBeenCalled();
    links=[{publicId:ID}];f.row.linkedGlobalCandidateId=ID;await f.cycle();
    expect(io.membership).toHaveBeenCalledTimes(2);expect(f.providers.startFullEnrich).toHaveBeenCalledOnce();
    expect(f.row.state).toBe('fullenrich_polling');
  });
  it('route refuses an SQL-identified applicant before creating an operation',async()=>{
    allowed=false;
    const response=await POST(new NextRequest('https://local.invalid/api/v3/candidates/candidate/find-contact',
      {method:'POST',body:JSON.stringify({trigger:'shortlist',jobId:'job'})}),{params:Promise.resolve({id:'candidate'})});
    expect(response.status).toBe(409);expect(io.operation).not.toHaveBeenCalled();
    expect(io.membership).not.toHaveBeenCalled();
  });
  it('route does not expose a cached email if the current link is absent',async()=>{
    io.operation.mockResolvedValue({...fixture().row,state:'found',globalCandidateId:ID,selectedEmail:'synthetic@example.invalid'});
    const response=await POST(new NextRequest('https://local.invalid/api/v3/candidates/candidate/find-contact',
      {method:'POST',body:JSON.stringify({trigger:'shortlist',jobId:'job'})}),{params:Promise.resolve({id:'candidate'})});
    expect(response.status).toBe(202);expect(await response.json()).toMatchObject({state:'pending',emails:[]});
    expect(io.lookup).not.toHaveBeenCalled();
  });
  it('refuses an applicant when the delayed link arrives without calling a provider',async()=>{
    const f=fixture();await f.cycle();links=[{publicId:ID}];f.row.linkedGlobalCandidateId=ID;
    io.membership.mockResolvedValue({results:[{isApplicant:true}]});await f.cycle();
    expect(f.row.state).toBe('failed');expect(f.memory.lookup).not.toHaveBeenCalled();
    expect(f.providers.startFullEnrich).not.toHaveBeenCalled();expect(f.providers.callEnrichLayer).not.toHaveBeenCalled();
  });
  it('private applicants are refused immediately even with no global link',async()=>{
    allowed=false;const f=fixture();await f.cycle();expect(f.row.state).toBe('failed');
    expect(io.membership).not.toHaveBeenCalled();expect(f.providers.startFullEnrich).not.toHaveBeenCalled();
  });
  it('does not dispatch if the link disappears after the Memory lookup',async()=>{
    links=[{publicId:ID}];const f=fixture();f.row.linkedGlobalCandidateId=ID;
    f.memory.lookup.mockImplementation(async()=>{links=[];return {state:'miss'};});await f.cycle();
    expect(f.row.state).toBe('failed');expect(f.providers.startFullEnrich).not.toHaveBeenCalled();
  });
});
