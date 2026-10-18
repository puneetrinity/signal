import { afterEach, describe, expect, it, vi } from 'vitest';
const boundary=vi.hoisted(()=>({publicLane:vi.fn(),privateLane:vi.fn(),purchase:vi.fn(),pool:vi.fn()}));
vi.mock('@/lib/prisma',()=>({prisma:{jobSourcingRequest:{findUnique:async()=>null},$queryRaw:boundary.pool}}));
vi.mock('@/lib/redis/client',()=>({redis:null}));
vi.mock('@/lib/candidate-privacy/repository',()=>({requireHealthyCandidatePrivacyContext:async()=>({cursor:BigInt(0),generation:BigInt(1)})}));
vi.mock('../activegraph-client',async original=>({...await original<typeof import('../activegraph-client')>(),searchPublicGlobalPool:boundary.publicLane,searchTenantPrivateCandidates:boundary.privateLane,
 HOME_POOL_LIMIT:300,HOME_POOL_ENABLED:true}));
vi.mock('../crustdata-acquisition',async original=>({...await original<typeof import('../crustdata-acquisition')>(),acquireCrustdataSearchForRequest:boundary.purchase}));
import { assertRetrievalPoolBound, fetchMemorySearch, retrieveMemoryLanes, SearchRetrievalError } from '../search-retrieval';
import {GovernedRepository} from '../governed-authority';
import {RcRepository} from '../rc-skills/repository';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('required Memory retrieval', () => {
  it('starts both lanes together and accepts successful empty results', async () => {
    let release!: () => void;
    const first = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return []; });
    const second = vi.fn(async () => { release(); return []; });
    expect(await retrieveMemoryLanes(first, second)).toEqual({ publicLane: [], privateLane: [] });
    expect(first).toHaveBeenCalledWith(15000);
    expect(second).toHaveBeenCalledTimes(1);
  });
  it('retries only the failed lane once, retaining a valid other lane', async () => {
    const first = vi.fn().mockRejectedValueOnce(new SearchRetrievalError('transport', true)).mockResolvedValue(['one']);
    const second = vi.fn(async () => ['two']);
    const sleep = vi.fn(async () => {});
    expect(await retrieveMemoryLanes(first, second, { sleep, jitter: () => 0 })).toEqual({ publicLane: ['one'], privateLane: ['two'] });
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(250);
  });
  it.each(['invalid_contract', 'privacy_unavailable', 'unauthorized'] as const)('does not retry %s', async code => {
    const lane = vi.fn(async () => { throw new SearchRetrievalError(code); });
    await expect(retrieveMemoryLanes(lane, async () => [])).rejects.toThrow();
    expect(lane).toHaveBeenCalledTimes(1);
  });
  it('does not turn exhausted transport failures into an empty lane', async () => {
    const lane = vi.fn(async () => { throw new SearchRetrievalError('transport', true); });
    await expect(retrieveMemoryLanes(lane, async () => [], { sleep: async () => {} })).rejects.toThrow('MEMORY_RETRIEVAL_TRANSPORT');
    expect(lane).toHaveBeenCalledTimes(2);
  });
  it('honours a common deadline and never sleeps beyond it', async () => {
    let now = 0;
    const lane = vi.fn(async () => { now = 29900; throw new SearchRetrievalError('rate_limited', true, 1000); });
    const sleep = vi.fn(async () => {});
    await expect(retrieveMemoryLanes(lane, async () => [], { now: () => now, sleep })).rejects.toThrow();
    expect(lane).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
  it('checks the undeduplicated pool bound before retrieval/purchase', () => {
    expect(() => assertRetrievalPoolBound(300, 300, 150)).not.toThrow();
    expect(() => assertRetrievalPoolBound(500, 500, 150)).not.toThrow();
    for (const values of [[1000,1000,150], [NaN,300,150], [300,300,-1], [0,300,150], [300.1,300,150]]) {
      expect(() => assertRetrievalPoolBound(values[0],values[1],values[2])).toThrow('MEMORY_RETRIEVAL_CONFIGURATION');
    }
  });
  it('keeps the HTTP timeout active until the body finishes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => ({ ok: true, text: () => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('body aborted')));
    }) })));
    const pending = fetchMemorySearch('http://localhost/test', {}, 20);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'transport', retryable: true });
    await vi.advanceTimersByTimeAsync(21);
    await assertion;
  });
  it('measures network and body separately without returning response content to the observer',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('synthetic private content')));
    const timing=vi.fn();
    const response=await fetchMemorySearch('http://localhost/test',{},100,timing);
    expect(await response.text()).toBe('synthetic private content');
    expect(timing.mock.calls.map(call=>call[0])).toEqual(['networkMs','bodyReadMs']);
    for(const call of timing.mock.calls){expect(call).toHaveLength(2);expect(call[1]).toBeGreaterThanOrEqual(0);}
  });
  it.each([[401,false], [403,false], [404,false], [429,true], [503,true]] as const)('classifies HTTP %s without leaking its body', async (status,retryable) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('sensitive provider text', {status})));
    await expect(fetchMemorySearch('http://localhost/test', {}, 100)).rejects.toMatchObject({retryable});
  });
});

describe('actual orchestration pre-purchase boundary',()=>{
 it.each(['transport','privacy_unavailable','invalid_contract','configuration'] as const)('does not substitute a local pool or buy on %s failure',async code=>{
  vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('NETWORK_FORBIDDEN');}));
  vi.stubEnv('RC_SKILLS_ENABLED','true');vi.stubEnv('SOURCE_TWO_LAYER_POOL_ENABLED','true');
  vi.stubEnv('SOURCE_PUBLIC_MEMORY_HYDRATION_ENABLED','true');vi.stubEnv('SOURCE_HOME_POOL_LIMIT',code==='configuration'?'1000':'300');
  boundary.publicLane.mockReset().mockRejectedValue(new SearchRetrievalError(code==='configuration'?'transport':code,code==='transport'));
  boundary.privateLane.mockReset().mockResolvedValue({results:[],total:0,appliedLimit:300});
  boundary.purchase.mockReset();boundary.pool.mockReset();
  vi.spyOn(GovernedRepository.prototype,'call').mockResolvedValue({protocolVersion:2,flowRunId:'10000000-0000-4000-8000-000000000001',rankingContract:{payload:{schemaVersion:3}}});
  vi.spyOn(RcRepository.prototype,'retrievalConfiguration').mockImplementation(async(_identity,config)=>config);
  const {runSourcingOrchestrator}=await import('../orchestrator');
  await expect(runSourcingOrchestrator('synthetic-request','org_28',{title:'Backend Engineer',skills:['Python'],goodToHaveSkills:[],jdDigest:'{}',location:'Bengaluru'},undefined,1,'execution','lease'))
   .rejects.toThrow(`MEMORY_RETRIEVAL_${code.toUpperCase()}`);
  expect(boundary.purchase).not.toHaveBeenCalled();expect(boundary.pool).not.toHaveBeenCalled();
  expect(boundary.publicLane).toHaveBeenCalledTimes(code==='configuration'?0:code==='transport'?2:1);
  expect(boundary.privateLane).toHaveBeenCalledTimes(code==='configuration'?0:1);
 });
});
