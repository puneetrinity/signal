import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {adaptProfile} from '../../rubric/evidence';
import {rankingHash} from '../../rubric/contracts';
import {rcPublicIdentities} from '../membership';
import {createObservation,rcValidUntil} from '../contracts';
import {rcBaselineSchema,type RcSnapshot} from '../repository';
import {encodeRcPreparation} from '../canonical-transport';
import {mergeSealedRcEvidence} from '../evidence';
import {RcComputeState,RcComputeClient} from '../rc-compute-worker';

function fixture(){
 const asOf='2026-10-13T00:00:00.000Z';
 const identities=rcPublicIdentities([{candidateId:'a',globalCandidateId:randomUUID(),url:'https://linkedin.com/in/a'}]);
 const observation=createObservation({version:1,outcome:'success',identityHash:identities[0].identityHash,skills:['Rust'],
  upstreamAt:asOf,observedAt:asOf,validUntil:rcValidUntil(asOf),timestampSource:'fetch_updated_at'});
 const baseline=rcBaselineSchema.parse({version:1,asOf,identities,cache:[{identityHash:observation.identityHash,observation}],withheld:[],
  evidence:[adaptProfile({candidateId:'a',organizationRef:'1',sourceVersion:'fixture',observedAt:asOf,profile:{skills:['Java']}})]});
 const snapshot:RcSnapshot={version:1,protocolMode:2,runId:randomUUID(),revision:'1',state:'complete',baseline,baselineHash:rankingHash(baseline),
  deadlineAt:asOf,sealedAt:asOf,outcomeSetHash:'a'.repeat(64),rcAvailable:true,members:[],attempts:[],
  progress:{version:1,state:'complete',processed:0,total:0,updatedAt:asOf,notificationDelivered:false,safeReason:'working'}};
 const {baseline:_,...header}=snapshot;return {baseline,snapshot,header};
}
describe('RC pure computation ownership',()=>{
 it('prepares identical wire and hash without mutating its input',()=>{
  const {baseline}=fixture(),before=JSON.stringify(baseline),state=new RcComputeState();
  const result=state.handle({kind:'prepare',baseline,receiptIds:[]}) as any;
  expect(JSON.parse(result.wire)).toEqual(encodeRcPreparation(baseline,[]));
  expect(result.baselineHash).toBe(rankingHash(baseline));expect(JSON.stringify(baseline)).toBe(before);
 });
 it('owns validated profile data and returns only the dispatch plan',()=>{
  const {snapshot,header}=fixture(),state=new RcComputeState();
  const expected=mergeSealedRcEvidence(snapshot),loaded=state.handle({kind:'load',snapshot}) as any;
  expect(Object.keys(loaded.snapshot.baseline).sort()).toEqual(['asOf','cache','identities','version']);
  expect(loaded.snapshot.baseline.cache).toEqual([]); // No paid members need cache bodies on main.
  snapshot.baseline!.evidence[0].facts=[];
  const result=state.handle({kind:'merge',snapshot:header}) as any;
  expect(result.evidence).toEqual(expected.evidence);expect(rankingHash(result.evidence)).toBe(rankingHash(expected.evidence));
  expect(()=>state.handle({kind:'load',snapshot})).toThrow('RC_COMPUTE_ALREADY_INITIALIZED');
 });
 it('filters a Memory-restricted person in preparation without changing caller data',()=>{
  const {baseline}=fixture(),state=new RcComputeState(),before=JSON.stringify(baseline);
  state.handle({kind:'begin',baseline:{...baseline,cache:[]}});
  const result=state.handle({kind:'finishPreparation',cache:[],restrictedIds:['a'],receiptIds:[]}) as any;
  const wire=JSON.parse(result.wire);
  expect(wire.baselineTransport.evidenceCanonical).toEqual([]);expect(wire.baselineTransport.identitiesCanonical).toEqual([]);
  expect(JSON.stringify(baseline)).toBe(before);
 });
 it.each(['run','hash','revision','unsealed','baseline_payload'] as const)('rejects %s mismatch at merge',change=>{
  const {snapshot,header}=fixture(),state=new RcComputeState();state.handle({kind:'load',snapshot});
  const modified:any={...header};
  if(change==='run')modified.runId=randomUUID();
  if(change==='hash')modified.baselineHash='b'.repeat(64);
  if(change==='revision')modified.revision='0';
  if(change==='unsealed')modified.sealedAt=null;
  if(change==='baseline_payload')modified.baseline=snapshot.baseline;
  expect(()=>state.handle({kind:'merge',snapshot:modified})).toThrow();
 });
 it('refuses unknown operations and observation bodies from another identity',()=>{
  const {snapshot}=fixture(),state=new RcComputeState();state.handle({kind:'load',snapshot});
  expect(()=>state.handle({kind:'provider',url:'https://example.invalid'})).toThrow();
  expect(()=>state.handle({kind:'observations',runId:snapshot.runId,baselineHash:snapshot.baselineHash,
   records:[{attemptId:randomUUID(),identityHash:'b'.repeat(64),outcomeHash:'a'.repeat(64),outcome:{kind:'restricted'}}]})).toThrow('RC_COMPUTE_IDENTITY_CONFLICT');
 });
 it('runs prepare/load/merge on the real capped helper and sanitizes errors without inline fallback',async()=>{
  const {baseline,snapshot,header}=fixture(),client=new RcComputeClient();
  try{
   const prepared=await client.call({kind:'prepare',baseline,receiptIds:[]});expect(prepared.baselineHash).toBe(rankingHash(baseline));
   await client.call({kind:'load',snapshot});
   const merged=await client.call({kind:'merge',snapshot:header});expect(merged.evidence).toEqual(mergeSealedRcEvidence(snapshot).evidence);
   await expect(client.call({kind:'merge',snapshot:{secret:'must not appear'}})).rejects.toThrow('RC_COMPUTE_INVALID');
   await expect(client.call({kind:'merge',snapshot:header})).rejects.toThrow('RC_COMPUTE_CLOSED');
  }finally{await client.dispose();}
 },15000);
 it('rejects concurrent messages and releases an interrupted helper without an inline retry',async()=>{
  const {baseline}=fixture(),client=new RcComputeClient();
  const pending=client.call({kind:'prepare',baseline,receiptIds:[]});
  // Attach rejection handlers before disposal so interrupted work cannot leak
  // an unhandled rejection into the sourcing process.
  const interrupted=expect(pending).rejects.toThrow('RC_COMPUTE_CLOSED');
  await expect(client.call({kind:'prepare',baseline,receiptIds:[]})).rejects.toThrow('RC_COMPUTE_BUSY');
  await client.dispose();await interrupted;
  await client.dispose();
  await expect(client.call({kind:'prepare',baseline,receiptIds:[]})).rejects.toThrow('RC_COMPUTE_CLOSED');
 });
});
