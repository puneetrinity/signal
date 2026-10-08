import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {NextRequest,NextResponse} from 'next/server';
const routeMocks=vi.hoisted(()=>({auth:vi.fn(),scope:vi.fn(),privacy:vi.fn(),enqueue:vi.fn()}));
const resultMocks=vi.hoisted(()=>({candidates:vi.fn(),identities:vi.fn()}));
const workerMocks=vi.hoisted(()=>({update:vi.fn(),find:vi.fn(),published:vi.fn(),count:vi.fn(),receipts:vi.fn(),execute:vi.fn(),orchestrate:vi.fn(),callback:vi.fn()}));
vi.mock('@/lib/prisma',()=>({prisma:{jobSourcingRequest:{updateMany:workerMocks.update,findUniqueOrThrow:workerMocks.find,findFirst:workerMocks.published,count:workerMocks.count},
  jobSourcingCandidate:{findMany:resultMocks.candidates},identityCandidate:{findMany:resultMocks.identities},confirmedIdentity:{findMany:resultMocks.identities},
  crustdataAcquisitionReceipt:{findMany:workerMocks.receipts},$executeRaw:workerMocks.execute}}));
vi.mock('../orchestrator',()=>({runSourcingOrchestrator:workerMocks.orchestrate}));
vi.mock('../callback',()=>({deliverCallback:workerMocks.callback}));
vi.mock('@/lib/auth/service-jwt',()=>({verifyServiceJWT:routeMocks.auth}));
vi.mock('@/lib/auth/service-scopes',()=>({requireScope:routeMocks.scope}));
vi.mock('@/lib/candidate-privacy/repository',()=>({requireHealthyCandidatePrivacyContext:routeMocks.privacy,candidatePrivacyAllowedRelationWhere:()=>({admitted:true})}));
vi.mock('@/lib/sourcing/queue/producer',()=>({getSourcingQueue:()=>({add:routeMocks.enqueue}),getRedisConnection:()=>({}),SOURCING_QUEUE_NAME:'test'}));
import { artifactHash, governedEnabled, governedSourceSchema, parseGovernedSource, previewObservation } from '../governed-contracts';
import {GovernedRepository,runGovernedPreview} from '../governed-authority';
import {RankingRepository} from '../rubric/repository';
const id='10000000-0000-4000-8000-000000000001', hash='a'.repeat(64);
const artifact={compilerVersion:'1' as const,digestVersion:3 as const,jobContext:{title:'Backend Engineer',location:'Bengaluru',jdDigest:'{}',skills:['Python'],goodToHaveSkills:[]},
  criterionMap:[{criterionId:id,use:'assessment' as const,field:null}],briefVersionId:id,materialHash:hash,sourceHash:hash,digestBasisHash:hash,previewQueryHash:hash,queryHash:hash};
artifact.queryHash=artifactHash(artifact);
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
const command={protocolVersion:1,flowRunId:id,organizationRef:'28',externalJobId:'vanta:jobs:147',briefVersionId:id,materialHash:hash,
  artifactHash:artifact.queryHash,compilerVersion:'1',queryArtifact:artifact,callbackUrl:'https://flow.example/api/webhooks/signal/callback'};
describe('actual governed source and preview route handlers',()=>{
  beforeEach(()=>{
    vi.stubEnv('FLOW_SOURCING_V1_ENABLED','true');
    routeMocks.auth.mockReset().mockResolvedValue({authorized:true,context:{tenantId:'fixture'}});
    routeMocks.scope.mockReset().mockReturnValue({authorized:true});
    routeMocks.privacy.mockReset().mockResolvedValue({});routeMocks.enqueue.mockReset().mockResolvedValue({});
  });
  const request=(body:unknown)=>new NextRequest('http://localhost/api/v3/jobs/vanta:jobs:147/source',{method:'POST',body:JSON.stringify(body)});
  const params={params:Promise.resolve({id:'vanta:jobs:147'})};
  it('authenticates and checks privacy before source admission or parsing',async()=>{
    const {POST}=await import('@/app/api/v3/jobs/[id]/source/route');
    const calls=vi.spyOn(GovernedRepository.prototype,'call');
    routeMocks.auth.mockResolvedValueOnce({authorized:false,response:NextResponse.json({}, {status:401})});
    expect((await POST(request(command),params)).status).toBe(401);expect(routeMocks.privacy).not.toHaveBeenCalled();
    routeMocks.privacy.mockRejectedValueOnce(Error('unavailable'));
    expect((await POST(request(command),params)).status).toBe(503);
    expect(calls).not.toHaveBeenCalled();expect(routeMocks.enqueue).not.toHaveBeenCalled();
  });
  it('enqueues the same governed execution with bounded reuse retries and never falls into legacy admission',async()=>{
    const {POST}=await import('@/app/api/v3/jobs/[id]/source/route');
    vi.spyOn(GovernedRepository.prototype,'tenant').mockResolvedValue({latched:true,allowNew:true,organizationRef:'28',callbackUrl:command.callbackUrl});
    const binding={requestId:id,status:'queued',executionAttemptId:id,acquisitionGeneration:1};
    const call=vi.spyOn(GovernedRepository.prototype,'call').mockResolvedValue(binding);
    for(let n=0;n<2;n++)expect((await POST(request(command),params)).status).toBe(202);
    expect(call.mock.calls.map(c=>c[0])).toEqual(['bind','bind']);
    expect(routeMocks.enqueue).toHaveBeenLastCalledWith('source',expect.objectContaining({requestId:id,executionAttemptId:id}),
      {jobId:`${id}-${id}`,attempts:3,backoff:{type:'exponential',delay:5000}});
    vi.stubEnv('FLOW_SOURCING_V1_ENABLED','false');
    expect((await POST(request(command),params)).status).toBe(409);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('preserves the legacy invalid-body response when governance is off',async()=>{
    const {POST}=await import('@/app/api/v3/jobs/[id]/source/route');
    vi.stubEnv('FLOW_SOURCING_V1_ENABLED','false');
    vi.spyOn(GovernedRepository.prototype,'tenant').mockResolvedValue({latched:false,allowNew:false,organizationRef:null,callbackUrl:null});
    const response=await POST(request({}),params);
    expect(response.status).toBe(400);expect(await response.json()).toMatchObject({success:false,error:expect.any(Array)});
    expect(routeMocks.enqueue).not.toHaveBeenCalled();
  });
  it('preview queue failure replays the same durable identity, with failed queue jobs removable',async()=>{
    const {POST}=await import('@/app/api/v3/jobs/[id]/preview/route');
    const call=vi.spyOn(GovernedRepository.prototype,'call').mockResolvedValue({state:'pending',previewId:id});
    routeMocks.enqueue.mockRejectedValueOnce(Error('Redis unavailable'));
    const body={protocolVersion:1,previewId:id,artifactHash:artifact.queryHash,queryArtifact:artifact};
    expect((await POST(request(body),params)).status).toBe(503);
    expect((await POST(request(body),params)).status).toBe(202);
    expect(call.mock.calls.map(c=>c[0])).toEqual(['previewAdmit','previewAdmit']);
    expect(routeMocks.enqueue).toHaveBeenLastCalledWith('preview',{kind:'preview',tenantId:'fixture',previewId:id},
      {jobId:`preview-${id}`,attempts:3,backoff:{type:'exponential',delay:5000},removeOnComplete:true,removeOnFail:true});
    call.mockResolvedValueOnce({state:'unknown',previewId:id});
    expect((await POST(request(body),params)).status).toBe(200);expect(routeMocks.enqueue).toHaveBeenCalledTimes(2);
  });
  it.each(['source','preview'] as const)('%s returns permanent, closed refusals, not retryable database details',async route=>{
    const {POST}=route==='source'?await import('@/app/api/v3/jobs/[id]/source/route'):await import('@/app/api/v3/jobs/[id]/preview/route');
    vi.spyOn(GovernedRepository.prototype,'tenant').mockResolvedValue({latched:true,allowNew:true,organizationRef:'28',callbackUrl:command.callbackUrl});
    const call=vi.spyOn(GovernedRepository.prototype,'call');
    const body=route==='source'?command:{protocolVersion:1,previewId:id,artifactHash:artifact.queryHash,queryArtifact:artifact};
    for(const code of ['GOVERNED_REQUEST_CONFLICT','GOVERNED_TARGET_MISMATCH','GOVERNED_TENANT_REQUIRED','GOVERNED_DISABLED']) {
      for(const error of [Error(code),Object.assign(Error('private SQL and credentials'),{code:'P2010',meta:{code:'P0001',message:`ERROR: ${code}`}})]) {
        call.mockRejectedValueOnce(error);
        const response=await POST(request(body),params);
        expect(response.status).toBe(409);expect(await response.json()).toEqual({error:code});
      }
    }
    call.mockRejectedValueOnce(Error('database transport unavailable'));
    expect((await POST(request(body),params)).status).toBe(503);
    expect(routeMocks.enqueue).not.toHaveBeenCalled();
  });
});
describe('actual governed results route',()=>{
  beforeEach(()=>{
    routeMocks.auth.mockReset().mockResolvedValue({authorized:true,context:{tenantId:'fixture'}});
    routeMocks.scope.mockReset().mockReturnValue({authorized:true});routeMocks.privacy.mockReset().mockResolvedValue({});
    resultMocks.candidates.mockReset().mockResolvedValue([{candidateId:'blocked'},{candidateId:'visible'}]);
    resultMocks.identities.mockReset().mockResolvedValue([]);
  });
  const row=(status='complete',protocolVersion=2)=>({id,externalJobId:command.externalJobId,flowRunId:id,protocolVersion,status,
    executionAttemptId:id,jobContext:{},candidates:[],lastRerankedAt:new Date('2026-10-01T00:00:00Z')});
  async function get(){
    const {GET}=await import('@/app/api/v3/jobs/[id]/results/route');
    return GET(new NextRequest('https://discover.example/api/v3/jobs/job/results'),{params:Promise.resolve({id:command.externalJobId})});
  }
  it.each([['queued',202],['processing',202],['failed',409],['expired',409]])('returns truthful %s status without retryable conflict',async(status,code)=>{
    workerMocks.published.mockResolvedValue(row(String(status)));
    const calls=vi.spyOn(GovernedRepository.prototype,'call');
    expect((await get()).status).toBe(code);expect(calls).not.toHaveBeenCalled();
  });
  it('removes blocked IDs from the service response while preserving the visible original ordinal',async()=>{
    workerMocks.published.mockResolvedValue({...row(),candidates:[{candidateId:'visible',rank:2,fitScore:null,sourceType:'pool',
      candidate:{id:'visible',intelligenceSnapshots:[],enrichmentSessions:[],searchMeta:null}}]});
    const calls=vi.spyOn(GovernedRepository.prototype,'call').mockResolvedValue({protocolVersion:2,flowRunId:id,artifactHash:hash,
      executionAttemptId:id,revision:1,orderedSignalIds:['blocked','visible'],rankingRevision:id,rankingHash:hash,contractHash:hash});
    vi.spyOn(RankingRepository.prototype,'read').mockResolvedValue({protocolVersion:2,flowRunId:id,revisionId:id,outputHash:hash,contractHash:hash,
      asOf:'2026-10-01T00:00:00.000Z',items:[{candidateId:'blocked',ordinal:1},{candidateId:'visible',ordinal:2}]} as never);
    const response=await get(),body=await response.json();expect(response.status).toBe(200);
    expect(body.governed.orderedSignalIds).toEqual(['visible']);expect(body.data[0].ranking.ordinal).toBe(2);
    expect(JSON.stringify(body)).not.toContain('blocked');expect(body.resultCount).toBe(1);
    expect(calls.mock.calls.map(([op])=>op)).toEqual(['delivery']);
  });
  it('leaves protocol1 on its original delivery path with no ranking or bound-command read',async()=>{
    workerMocks.published.mockResolvedValue(row('complete',1));resultMocks.candidates.mockResolvedValue([]);
    const calls=vi.spyOn(GovernedRepository.prototype,'call').mockResolvedValue({protocolVersion:1,orderedSignalIds:[]});
    const read=vi.spyOn(RankingRepository.prototype,'read');
    expect((await get()).status).toBe(200);expect(read).not.toHaveBeenCalled();
    expect(calls.mock.calls.map(([op])=>op)).toEqual(['delivery']);
  });
  it('returns permanent 409 for ranking conflict and temporary 503 for unavailable authority',async()=>{
    workerMocks.published.mockResolvedValue(row());
    const calls=vi.spyOn(GovernedRepository.prototype,'call').mockResolvedValue(null);
    expect((await get()).status).toBe(409);
    calls.mockRejectedValue(Object.assign(Error('Prisma query failed'),{code:'P2010',meta:{code:'P0001',message:'ERROR: RANKING_OUTPUT_CONFLICT'}}));
    expect((await get()).status).toBe(409);
    calls.mockRejectedValue(Error('database unavailable'));expect((await get()).status).toBe(503);
  });
});
describe('actual sourcing worker failure handling',()=>{
  beforeEach(()=>{
    routeMocks.privacy.mockReset().mockResolvedValue({});
    workerMocks.update.mockReset().mockResolvedValue({count:1});
    workerMocks.find.mockReset().mockResolvedValue({jobContext:artifact.jobContext});
    workerMocks.published.mockReset().mockResolvedValue(null);
    workerMocks.receipts.mockReset().mockResolvedValue([{slot:'exact',status:'complete'}]);
    workerMocks.execute.mockReset().mockResolvedValue(1);
    workerMocks.orchestrate.mockReset().mockRejectedValue(Error('local orchestration failed'));
    workerMocks.callback.mockReset().mockResolvedValue({});
    workerMocks.count.mockReset().mockResolvedValue(1);
  });
  async function run(attemptsMade=2,legacy=false) {
    const {processSourcingJob}=await import('../queue');
    return processSourcingJob({id:'test',attemptsMade,opts:{attempts:3},data:{...(legacy?{}:{kind:'source'}),requestId:id,tenantId:'fixture',externalJobId:command.externalJobId,
      callbackUrl:command.callbackUrl,acquisitionGeneration:1,executionAttemptId:id,resolvedTrack:{track:'tech'}}} as unknown as Parameters<typeof processSourcingJob>[0]);
  }
  const operations=()=>workerMocks.update.mock.calls.map(([arg])=>arg);
  function repository(cancel:unknown=null) {
    return vi.spyOn(GovernedRepository.prototype,'call').mockImplementation(async operation=>{
      if(operation==='execution' || operation==='boundCommand')return {};
      if(operation==='cancel')return cancel;
      return null;
    });
  }
  it('resumes sealed ranking before retrieval or acquisition and never rewrites its completion',async()=>{
    const calls=repository();
    calls.mockImplementation(async op=>op==='execution'?{protocolVersion:2,flowRunId:id,rankingContract:{fixture:true}}:null);
    const resume=vi.spyOn(RankingRepository.prototype,'resume').mockResolvedValue({items:[{candidateId:'one'}]} as never);
    expect(await run(1)).toMatchObject({status:'complete',candidateCount:1});
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({tenantId:'fixture',flowRunId:id,executionAttemptId:id,
      processingLeaseId:operations()[0].data.processingLeaseId}));
    expect(routeMocks.privacy.mock.invocationCallOrder[0]).toBeLessThan(resume.mock.invocationCallOrder[0]);
    expect(workerMocks.orchestrate).not.toHaveBeenCalled();expect(workerMocks.receipts).not.toHaveBeenCalled();
    expect(operations()).toHaveLength(1);
    expect(workerMocks.callback).toHaveBeenCalledWith(id,'fixture',command.callbackUrl,
      expect.objectContaining({status:'complete',candidateCount:1}),true,expect.objectContaining({executionAttemptId:id}));
  });
  it('uses atomic ranking completion, not the legacy completion writer, on the first attempt',async()=>{
    const calls=repository();
    calls.mockImplementation(async op=>op==='execution'?{protocolVersion:2,flowRunId:id,rankingContract:{fixture:true}}:null);
    vi.spyOn(RankingRepository.prototype,'resume').mockResolvedValue(null);
    vi.spyOn(RankingRepository.prototype,'read').mockResolvedValue({outputHash:hash,items:[{candidateId:'one'}]} as never);
    workerMocks.orchestrate.mockResolvedValue({candidateCount:1,ranking:{flowRunId:id,revisionId:id,outputHash:hash}});
    expect(await run(0)).toMatchObject({status:'complete',candidateCount:1});
    expect(operations()).toHaveLength(2); // execution claim and track diagnostics only
    expect(operations().some(op=>op.data.status==='complete')).toBe(false);
    expect(workerMocks.count).toHaveBeenCalledWith({where:expect.objectContaining({status:'complete',resultCount:1})});
  });
  it('privacy refusal prevents sealed-input reads as well as fresh orchestration',async()=>{
    const calls=repository();calls.mockImplementation(async op=>op==='execution'?{protocolVersion:2,flowRunId:id}:null);
    const resume=vi.spyOn(RankingRepository.prototype,'resume');
    routeMocks.privacy.mockRejectedValueOnce(Error('privacy unavailable'));
    await expect(run(0)).rejects.toThrow('privacy unavailable');
    expect(resume).not.toHaveBeenCalled();expect(workerMocks.orchestrate).not.toHaveBeenCalled();
  });
  it('delivers immediately after a real orchestration throw following publication, without cancel or second purchase',async()=>{
    const calls=repository();
    calls.mockImplementation(async op=>op==='execution'?{protocolVersion:2,flowRunId:id,rankingContract:{fixture:true}}:null);
    vi.spyOn(RankingRepository.prototype,'resume').mockResolvedValue(null);
    workerMocks.orchestrate.mockRejectedValue(Error('post-publication presentation failure'));
    workerMocks.published.mockResolvedValue({resultCount:7});
    expect(await run(0)).toMatchObject({status:'complete',candidateCount:7});
    expect(workerMocks.callback).toHaveBeenCalledOnce();
    expect(workerMocks.receipts).not.toHaveBeenCalled();
    expect(calls.mock.calls.some(([op])=>op==='cancel')).toBe(false);
    expect(operations().some(op=>op.data.status==='queued'||op.data.status==='failed')).toBe(false);
  });
  it('refuses protocol2 legacy completion even if the orchestrator returns without ranking',async()=>{
    const calls=repository();
    calls.mockImplementation(async op=>op==='execution'?{protocolVersion:2,flowRunId:id,rankingContract:{fixture:true}}:null);
    vi.spyOn(RankingRepository.prototype,'resume').mockResolvedValue(null);
    workerMocks.orchestrate.mockResolvedValue({candidateCount:20});
    await expect(run(0)).rejects.toThrow('RANKING_PUBLICATION_REQUIRED');
    expect(operations().some(op=>op.data.status==='complete')).toBe(false);
  });
  it('a lost callback after sealed publication cannot change a complete request into failed or queued',async()=>{
    const calls=repository();calls.mockImplementation(async op=>op==='execution'?{protocolVersion:2,flowRunId:id}:null);
    vi.spyOn(RankingRepository.prototype,'resume').mockResolvedValue({items:[]} as never);
    workerMocks.callback.mockRejectedValueOnce(Error('callback transport unavailable'));
    workerMocks.update.mockResolvedValue({count:0}).mockResolvedValueOnce({count:1});
    await run(1);
    for(const op of operations().slice(1))expect(op.where).toMatchObject({status:'processing',processingLeaseId:operations()[0].data.processingLeaseId});
    expect(workerMocks.execute).not.toHaveBeenCalled();expect(workerMocks.callback).toHaveBeenCalledOnce();
    expect(workerMocks.orchestrate).not.toHaveBeenCalled();
  });
  it('privacy failure after purchase retries within the cap, then durably fails with pending callback',async()=>{
    const calls=repository();routeMocks.privacy.mockRejectedValue(Error('privacy unavailable'));
    await expect(run(1)).rejects.toThrow('privacy unavailable');
    expect(operations()).toContainEqual(expect.objectContaining({data:{status:'queued',processingLeaseId:null}}));
    expect(calls.mock.calls.some(([op])=>op==='cancel')).toBe(false);
    const result=await run(2);expect(result.status).toBe('failed');
    expect(operations()).toContainEqual(expect.objectContaining({data:expect.objectContaining({status:'failed',callbackStatus:'pending'})}));
    expect(workerMocks.callback).toHaveBeenCalledOnce();expect(workerMocks.orchestrate).not.toHaveBeenCalled();
    const claim=operations()[0];
    expect(claim.where).toMatchObject({id,tenantId:'fixture',executionAttemptId:id,acquisitionGeneration:1});
    expect(operations()[1].where.processingLeaseId).toBe(claim.data.processingLeaseId);
  });
  it('preserves the legacy pre-claim privacy refusal while governance is off',async()=>{
    vi.stubEnv('FLOW_SOURCING_V1_ENABLED','false');
    const calls=repository();routeMocks.privacy.mockRejectedValue(Error('privacy unavailable'));
    await expect(run(0,true)).rejects.toThrow('privacy unavailable');
    expect(workerMocks.update).not.toHaveBeenCalled();expect(calls).not.toHaveBeenCalled();
    expect(workerMocks.orchestrate).not.toHaveBeenCalled();expect(workerMocks.callback).not.toHaveBeenCalled();
  });
  it('bounded orchestration recovery reuses complete receipts without cancellation',async()=>{
    const calls=repository();await expect(run(0)).rejects.toThrow('local orchestration failed');
    expect(operations().at(-1).data).toEqual({status:'queued',processingLeaseId:null});
    expect(calls.mock.calls.some(([op])=>op==='cancel')).toBe(false);
  });
  it('proven no-dispatch cancellation leaves the SQL-fenced terminal state alone',async()=>{
    repository({cancelled:true});workerMocks.receipts.mockResolvedValue([]);
    expect(await run()).toMatchObject({error:'GOVERNED_CANCELLED_NO_DISPATCH'});
    expect(operations()).toHaveLength(2); // claim + track diagnostics only
    expect(workerMocks.callback).not.toHaveBeenCalled();
  });
  it('ambiguous receipt cannot retry or refund and failed callback stays pending',async()=>{
    repository();workerMocks.receipts.mockResolvedValue([{slot:'exact',status:'uncertain'}]);
    workerMocks.callback.mockRejectedValue(Error('callback unavailable'));
    expect((await run(0)).status).toBe('failed');
    expect(operations().some(op=>op.data.status==='queued')).toBe(false);
    expect(operations().at(-1).data).toMatchObject({status:'failed',callbackStatus:'pending'});
  });
  it('stale and failed claims never mutate or process another execution',async()=>{
    const calls=repository();workerMocks.update.mockResolvedValueOnce({count:0});
    expect(await run()).toMatchObject({error:'Sourcing execution was superseded'});
    expect(calls).not.toHaveBeenCalled();expect(routeMocks.privacy).not.toHaveBeenCalled();
    workerMocks.update.mockRejectedValueOnce(Error('database unavailable'));
    await expect(run(0)).rejects.toThrow('database unavailable');
    expect(workerMocks.find).not.toHaveBeenCalled();expect(workerMocks.callback).not.toHaveBeenCalled();
  });
  it('reconciles a transient final claim failure without stealing a different lease',async()=>{
    repository();workerMocks.update.mockRejectedValueOnce(Error('claim response lost'));
    expect((await run(2)).status).toBe('failed');
    expect(operations()[1].where.OR).toEqual([{status:'queued',processingLeaseId:null},
      {status:'processing',processingLeaseId:operations()[0].data.processingLeaseId}]);
    expect(operations().at(-1).data).toMatchObject({status:'failed',callbackStatus:'pending'});
    expect(workerMocks.callback).toHaveBeenCalledOnce();expect(workerMocks.orchestrate).not.toHaveBeenCalled();
  });
});
describe('governed source wire authority',()=>{
  it('does not interpret malformed or RLS-hidden tenant evidence as an unlatched account',async()=>{
    for(const rows of [[],[{result:null}],[{tenant_id:'tenant',allow_new:true}]]) {
      await expect(new GovernedRepository(async()=>rows).tenant('tenant')).rejects.toThrow();
    }
    expect(await new GovernedRepository(async()=>[{result:{latched:false,allowNew:false,organizationRef:null,callbackUrl:null}}]).tenant('tenant'))
      .toMatchObject({latched:false,allowNew:false});
  });
  it('is closed, bound to the compiled query and disallows force/refresh',()=>{
    expect(governedSourceSchema.safeParse(command).success).toBe(true);
    for(const patch of [{force:true},{refresh:true},{artifactHash:hash},{queryArtifact:{...artifact,jobContext:{...artifact.jobContext,location:'Different'}}}]) {
      expect(governedSourceSchema.safeParse({...command,...patch}).success).toBe(false);
    }
  });
  it('requires exact configured callback and external job, not arbitrary URLs',()=>{
    const expected={externalJobId:command.externalJobId,callbackUrl:command.callbackUrl,production:true};
    expect(parseGovernedSource(command,expected).flowRunId).toBe(id);
    expect(()=>parseGovernedSource(command,{...expected,externalJobId:'vanta:jobs:148'})).toThrow('TARGET_MISMATCH');
    expect(()=>parseGovernedSource({...command,callbackUrl:'https://attacker.example'},expected)).toThrow('TARGET_MISMATCH');
    const local={...command,callbackUrl:'http://localhost/callback'};
    expect(()=>parseGovernedSource(local,{...expected,callbackUrl:local.callbackUrl})).toThrow('TARGET_MISMATCH');
  });
  it('stays off with no variable and refuses ambiguous booleans',()=>{
    expect(governedEnabled({})).toBe(false);
    expect(governedEnabled({FLOW_SOURCING_V1_ENABLED:'true'})).toBe(true);
    for(const raw of ['1','','TRUE'])expect(()=>governedEnabled({FLOW_SOURCING_V1_ENABLED:raw})).toThrow('CONFIGURATION_INVALID');
  });
});
describe('preview worker transport boundary',()=>{
  function fixture(claim=true) {
    vi.stubEnv('FLOW_SOURCING_V1_ENABLED','true');vi.stubEnv('CRUSTDATA_API_KEY','test-only-not-a-real-key');
    const events:string[]=[],finishes:unknown[]=[];
    const repository=new GovernedRepository(async(sql,args)=>{
      if(sql.includes('preview_claim')){events.push('durable-start');return [{result:claim?{previewId:id,lease:id,
        command:{protocolVersion:1,previewId:id,artifactHash:artifact.queryHash,queryArtifact:artifact}}:null}];}
      if(sql.includes('preview_finish')){events.push('durable-finish');finishes.push(args[3]);return [{result:{state:'complete'}}];}
      throw Error('UNEXPECTED_QUERY');
    });
    const redis={eval:async()=>{events.push('rate');return [1,0,'allowed'];}};
    return {repository,redis,events,finishes};
  }
  it('persists started before one HTTP call and keeps only count evidence',async()=>{
    const f=fixture();
    const transport=vi.fn(async(_url:unknown,init?:RequestInit)=>{
      f.events.push('http');expect(init?.redirect).toBe('error');expect(init?.signal).toBeDefined();
      expect((init?.headers as Record<string,string>)['x-api-version']).toBe('2025-11-01');
      expect(JSON.parse(String(init?.body))).toMatchObject({limit:1,fields:['crustdata_person_id']});
      return new Response(JSON.stringify({total_count:77,profiles:[{shouldNotPersist:'private'}]}),{headers:{'X-Credits-Used':'0.03'}});
    });
    expect(await runGovernedPreview(f.repository,f.redis,'tenant',id,transport as typeof fetch)).toEqual({state:'complete'});
    expect(f.events).toEqual(['rate','durable-start','http','durable-finish']);
    expect(f.finishes).toEqual([{state:'complete',count:77,countRelation:'approximate',creditsUsed:0.03}]);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('does not contact a provider for a duplicate or rate refusal',async()=>{
    const transport=vi.fn();const f=fixture(false);
    expect(await runGovernedPreview(f.repository,f.redis,'tenant',id,transport)).toEqual({state:'not_claimed'});
    expect(await runGovernedPreview(f.repository,{eval:async()=>[0,1000,'priority']},'tenant',id,transport))
      .toEqual({state:'waiting',retryAfterMs:1000});
    expect(transport).not.toHaveBeenCalled();expect(f.finishes).toEqual([]);
  });
  it.each(['timeout','missing-cost','oversized','provider-429'])('records uncertainty without retry: %s',async(mode)=>{
    const f=fixture();const transport=vi.fn(async()=>{
      if(mode==='timeout')throw Error('synthetic timeout');
      if(mode==='provider-429')return new Response('',{status:429});
      return new Response(mode==='oversized'?'x'.repeat(65537):JSON.stringify({total_count:1}));
    });
    expect(await runGovernedPreview(f.repository,f.redis,'tenant',id,transport as typeof fetch)).toEqual({state:'unknown'});
    expect(f.finishes).toEqual([{state:'unknown'}]);expect(transport).toHaveBeenCalledTimes(1);
  });
  it('never turns a failed durable finish into reported success',async()=>{
    const f=fixture();const repository=new GovernedRepository(async(sql)=>{
      if(sql.includes('preview_claim'))return [{result:{previewId:id,lease:id,command:{protocolVersion:1,previewId:id,artifactHash:artifact.queryHash,queryArtifact:artifact}}}];
      throw Error('database unavailable');
    });
    await expect(runGovernedPreview(repository,f.redis,'tenant',id,async()=>new Response(JSON.stringify({total_count:1}),{headers:{'X-Credits-Used':'0.03'}})))
      .rejects.toThrow('database unavailable');
  });
});
describe('preview evidence, not invented zero counts or costs',()=>{
  it('preserves zero and explicit lower bounds, discarding returned profiles',()=>{
    expect(previewObservation({total_count:0,profiles:[{private:'never retained'}]},'0')).toEqual({count:0,countRelation:'approximate',creditsUsed:0});
    expect(previewObservation({total_count:'1200',total_count_relation:'gte'},'0.03')).toEqual({count:1200,countRelation:'gte',creditsUsed:0.03});
  });
  it.each([null,undefined,'',-1,1.5,'1.5',true,Number.MAX_SAFE_INTEGER+1])('refuses invalid total case %#',total=>{
    expect(()=>previewObservation({total_count:total},'0.03')).toThrow('EVIDENCE_UNAVAILABLE');
  });
  it.each([null,'','NaN','-1','0.1','Infinity'])('refuses missing or unexpected credits case %#',credits=>{
    expect(()=>previewObservation({total_count:1200},credits)).toThrow('EVIDENCE_UNAVAILABLE');
  });
});
