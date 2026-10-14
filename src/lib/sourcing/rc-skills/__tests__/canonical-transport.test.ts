import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {canonical,rankingHash} from '../../rubric/contracts';
import {adaptProfile} from '../../rubric/evidence';
import {rcBaselineSchema,RcRepository} from '../repository';
import {encodeRcPreparation} from '../canonical-transport';
import {rcPublicIdentities} from '../membership';
import {observationBodySchema,createObservation} from '../contracts';

function baseline(){return rcBaselineSchema.parse({version:1,asOf:'2026-10-13T00:00:00.000Z',cache:[],withheld:[],identities:[],
 evidence:['z','a','é😀'].map(candidateId=>adaptProfile({candidateId,organizationRef:'1',profile:{skills:['C++','é😀','quote"\\\n']},sourceVersion:'test',observedAt:'2020-01-01T00:00:00.000Z'}))});}
describe('RC preparation canonical transport',()=>{
 it('streams exactly the old commitment with cache, withheld rows and both provenance labels',()=>{
  for(const timestampSource of ['check_last_update','fetch_updated_at'] as const){
   const b=baseline();b.identities=rcPublicIdentities([{candidateId:'z',globalCandidateId:randomUUID(),url:'https://linkedin.com/in/z'}]);
   const identityHash=b.identities[0].identityHash;
   b.cache=[{identityHash,observation:createObservation({version:1,outcome:'no_skills',identityHash,skills:[],
    upstreamAt:null,observedAt:b.asOf,validUntil:null,timestampSource})}];
   b.withheld=[{candidateId:'withheld-é😀',reason:'evidence_too_large',evidenceHash:'a'.repeat(64),bytes:65537,limit:65536}];
   const valid=rcBaselineSchema.parse(b),before=JSON.stringify(valid);
   expect(encodeRcPreparation(valid,['r']).baselineHash).toBe(rankingHash(valid));
   expect(JSON.stringify(valid)).toBe(before);
  }
 });
 it('pins machine-readable baseline and observation field lists',()=>{
  expect(Object.keys(rcBaselineSchema.innerType().shape).sort()).toEqual(['asOf','cache','evidence','identities','version','withheld']);
  expect(Object.keys(observationBodySchema.shape).sort()).toEqual(['identityHash','observedAt','outcome','skills','timestampSource','upstreamAt','validUntil','version']);
 });
 it('preserves unsorted array order and the historical commitment',()=>{
  const b=baseline(),t=encodeRcPreparation(b,[]);
  expect(t.baselineTransport.evidenceCanonical.map(s=>JSON.parse(s).candidateId)).toEqual(['z','a','é😀']);
  const decoded={version:1,asOf:t.asOf,evidence:t.baselineTransport.evidenceCanonical.map(s=>JSON.parse(s)),
   withheld:[],identities:[],cache:[]};
  expect(canonical(decoded)).toBe(canonical(b));expect(t.baselineHash).toBe(rankingHash(b));
  expect(encodeRcPreparation({...b,evidence:[...b.evidence].reverse()},[]).baselineHash).not.toBe(t.baselineHash);
 });
 it('encodes empty arrays without changing the baseline',()=>{
  const b={...baseline(),evidence:[]},t=encodeRcPreparation(b,[]);
  expect(t.baselineTransport.evidenceCanonical).toEqual([]);expect(t.baselineHash).toBe(rankingHash(b));
 });
 it('uses the tagged transport only after repository validation',async()=>{
  const b=baseline(),identity={tenantId:'org_1',flowRunId:randomUUID(),executionAttemptId:'execution',processingLeaseId:'lease'};
  let command:any;const repo=new RcRepository(async(_sql,args)=>{command=JSON.parse(args[2] as string);return[{result:{version:1,runId:randomUUID(),baselineHash:command.baselineHash,replayed:false}}];});
  await repo.prepare(identity,[],b);expect(command).toEqual(encodeRcPreparation(b,[]));
  command=null;await expect(repo.prepare(identity,[],{...b,evidence:[b.evidence[0],b.evidence[0]]})).rejects.toThrow();expect(command).toBeNull();
 });
 it('preserves public identity text and order',()=>{
  const b=baseline();b.identities=rcPublicIdentities([{candidateId:'z',globalCandidateId:randomUUID(),url:'https://linkedin.com/in/z'},{candidateId:'a',globalCandidateId:randomUUID(),url:'https://linkedin.com/in/a'}]);
  expect(encodeRcPreparation(b,[]).baselineTransport.identitiesCanonical.map(s=>JSON.parse(s))).toEqual(b.identities);
 });
});
