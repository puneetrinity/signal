import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {computeRankingMessage,runRankingComputation,type ComputeInput} from '../ranking-compute-worker';
import {adaptProfile} from '../evidence';
import {canonical,createRankingContract,rankingHash} from '../contracts';
import {rankEvidence} from '../score';

function fixture(n=3){
 const id=randomUUID(),asOf='2026-10-01T00:00:00.000Z';
 const contract=createRankingContract(id,'a'.repeat(64),{schemaVersion:2,compilerVersion:2,taxonomyVersion:2,criteria:[{
  id,label:'Role',class:'preferred',subject:'title',requirement:{kind:'accepted_titles',values:['Engineer']},
  use:'assessment',evidenceKinds:['profile_evidence'],provenance:{kind:'recruiter_edit'}}]});
 const evidence=Array.from({length:n},(_,i)=>({...adaptProfile({candidateId:'person-'+String(i).padStart(4,'0'),organizationRef:'1',
  profile:{experience:{employment_details:{current:[{title:'Engineer',start_date:'2020-01-01'}]}}},sourceVersion:'fixture',observedAt:asOf}),presentationSource:'pool' as const}));
 const inputHash=rankingHash({contractHash:contract.contractHash,asOf,evidence});
 const claim={state:'reserved',revisionId:randomUUID(),lease:randomUUID(),inputHash,asOf,contract,evidence,withheld:[]};
 return{contract,evidence,claim,asOf};
}
describe('ranking CPU worker — deterministic and no inline fallback',()=>{
 it('compact receipt scores the retained evidence identically and rejects a changed or absent local copy',async()=>{
  const f=fixture(),claim={state:'reserved_compact',revisionId:f.claim.revisionId,lease:f.claim.lease,inputHash:f.claim.inputHash,asOf:f.asOf,contractHash:f.contract.contractHash};
  const expected={evidence:f.evidence,withheld:[]};
  const result=await runRankingComputation({kind:'claim',input:{contract:f.contract,claim,expected}});
  expect(result).toEqual(computeRankingMessage({kind:'claim',input:{contract:f.contract,claim:f.claim}}));
  await expect(runRankingComputation({kind:'claim',input:{contract:f.contract,claim}})).rejects.toThrow('RANKING_INPUT_CONFLICT');
  await expect(runRankingComputation({kind:'claim',input:{contract:f.contract,claim,expected:{...expected,evidence:f.evidence.slice(1)}}})).rejects.toThrow('RANKING_INPUT_CONFLICT');
  await expect(runRankingComputation({kind:'claim',input:{contract:f.contract,claim:{...claim,contractHash:'0'.repeat(64)},expected}})).rejects.toThrow('RANKING_INPUT_CONFLICT');
  await expect(runRankingComputation({kind:'claim',input:{contract:f.contract,claim:{...claim,evidence:f.evidence},expected}})).rejects.toThrow('RANKING_COMPUTE_INVALID');
 },30000);
 it('real thread produces byte-identical old scoring output and hash while event loop keeps ticking',async()=>{
  const f=fixture(250),message:ComputeInput={kind:'claim',input:{contract:f.contract,claim:f.claim,expected:{evidence:f.evidence,withheld:[]}}};
  let ticks=0;const timer=setInterval(()=>ticks++,5);
  let result;try{result=await runRankingComputation(message);}finally{clearInterval(timer);}
  expect(result).toEqual(computeRankingMessage(message));expect(ticks).toBeGreaterThan(1);
  if(result.kind!=='computed'||result.state!=='reserved')throw Error('unexpected result');
  const old=rankEvidence(f.contract,f.evidence,f.asOf),selected=new Map(old.selected.map(i=>[i.candidateId,i.selectedOrdinal]));
  const expected={inputHash:f.claim.inputHash,items:old.items.map((item,index)=>({...item,ordinal:index+1,selectedOrdinal:selected.get(item.candidateId)??null,sourceType:'pool'}))};
  expect(result.command).toEqual({transportVersion:1,inputHash:expected.inputHash,itemsCanonical:expected.items.map(canonical),outputHash:rankingHash(expected)});
 },30000);
 it('preparation preserves canonical sorting, evidence and source metadata',async()=>{
  const f=fixture();const message:ComputeInput={kind:'prepare',input:{contract:f.contract,executionAttemptId:randomUUID(),processingLeaseId:randomUUID(),
   evidence:[...f.evidence].reverse(),sourceTypes:f.evidence.map(e=>[e.candidateId,'pool'])}};
  expect(await runRankingComputation(message)).toEqual(computeRankingMessage(message));
 });
 it('sorts both transport arrays in UTF8 byte order without losing alignment',()=>{
  const f=fixture(),ids=['😀','é','Z','a','雪'];
  const evidence=ids.map(candidateId=>({...f.evidence[0],candidateId}));
  const withheld=ids.map(candidateId=>({candidateId:'w'+candidateId,reason:'evidence_too_large' as const,evidenceHash:'a'.repeat(64),bytes:65537,limit:65536 as const}));
  const out=computeRankingMessage({kind:'prepare',input:{contract:f.contract,executionAttemptId:randomUUID(),processingLeaseId:randomUUID(),evidence,withheld,sourceTypes:evidence.map(e=>[e.candidateId,'pool'])}});
  if(out.kind!=='prepared')throw Error('prepare');
  const ordered=[...ids].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  expect(out.command.evidenceCanonical.map(s=>JSON.parse(s).candidateId)).toEqual(ordered);
  expect(out.command.withheldCanonical.map(s=>JSON.parse(s).candidateId)).toEqual(ordered.map(id=>'w'+id));
  expect(out.command.evidenceCanonical).toEqual(out.evidence.map(canonical));
 });
 it('refuses mismatched hashes and expected evidence without returning evidence in the error',async()=>{
  const f=fixture();
  await expect(runRankingComputation({kind:'claim',input:{contract:f.contract,claim:{...f.claim,inputHash:'0'.repeat(64)}}})).rejects.toThrow('RANKING_INPUT_CONFLICT');
  await expect(runRankingComputation({kind:'claim',input:{contract:f.contract,claim:f.claim,expected:{evidence:[],withheld:[]}}})).rejects.toThrow('RANKING_INPUT_CONFLICT');
 });
 it('ready replay returns only metadata, without rescoring',async()=>{
  const f=fixture(),claim={state:'ready',revisionId:randomUUID(),outputHash:'b'.repeat(64)};
  expect(await runRankingComputation({kind:'claim',input:{contract:f.contract,claim}})).toEqual({kind:'computed',...claim});
 });
 it('releases both CPU slots after rejected work so queued callers still finish',async()=>{
  const f=fixture(),bad:ComputeInput={kind:'claim',input:{contract:f.contract,claim:{...f.claim,inputHash:'0'.repeat(64)}}};
  const failures=await Promise.allSettled(Array.from({length:6},()=>runRankingComputation(bad)));
  expect(failures.every(r=>r.status==='rejected'&&r.reason.message==='RANKING_INPUT_CONFLICT')).toBe(true);
  const claim={state:'ready',revisionId:randomUUID(),outputHash:'b'.repeat(64)};
  expect(await runRankingComputation({kind:'claim',input:{contract:f.contract,claim}})).toEqual({kind:'computed',...claim});
 },30000);
});
