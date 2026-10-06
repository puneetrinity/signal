import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {beforeAll,describe,expect,it} from 'vitest';
import {buildCrustdataPreviewRequest,buildCrustdataRequest} from '../crustdata-client';
import type {JobRequirements,SourcingJobContextInput} from '../jd-digest';
import {buildJobRequirements} from '../jd-digest';
import {buildCrustdataRequestInput,buildCrustdataRequestFingerprint} from '../crustdata-acquisition';
import {buildRelaxationRungs} from '../relaxation-ladder';
import {deriveCountryCodeFromLocationText} from '@/lib/taxonomy/location-service';
import {governedHash,governedSourceSchema} from '../governed-contracts';

// Execute the actual pinned builder, not a second hand-written expectation.
// Its fetch is transport-only substituted and cannot reach a provider.
const baseline = execFileSync('git',['show','b17b65cd088bec5818bef27459690e61b051f1d7:src/lib/sourcing/crustdata-client.ts'],{encoding:'utf8'});
const compiled = ts.transpileModule(baseline,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const common: JobRequirements = {
  title:'Backend Engineer',topSkills:['python'],seniorityLevel:'senior',domain:'software',roleFamily:'backend',
  location:'Bengaluru, India',experienceYears:null,experienceYearsMax:null,education:null,
  titleSearchTerms:[' Backend Engineer ','API engineer'],adjacentBuckets:[],adjacentLocations:[],
};
async function pinnedRequest(requirements:JobRequirements,excludePersonIds:number[],limit:number) {
  let captured: {body:string;headers:Record<string,string>} | undefined;
  const exports={} as {searchPeople:(requirements:JobRequirements,limit:number,options:{excludePersonIds:number[]})=>Promise<unknown>};
  runInNewContext(compiled,{exports,process:{env:{CRUSTDATA_API_KEY:'transport-only-fixture'}},
    console:{log(){},error(){}},
    require(name:string){if(name!=='@/lib/logger') throw Error('UNEXPECTED_BASELINE_IMPORT');return {createLogger:()=>({info(){},error(){}})};},
    fetch:async (_url:string,request:{body:string;headers:Record<string,string>})=>{captured=request;return {ok:true,json:async()=>({profiles:[],total_count:0})};},
  });
  await exports.searchPeople(requirements,limit,{excludePersonIds});
  if(!captured) throw Error('BASELINE_DID_NOT_DISPATCH');
  return captured;
}
describe('Crustdata pinned transport parity (no provider calls)',()=>{
  it('replays the fixed Flow compiler wire vector in ordinary CI without a peer checkout',()=>{
    // This output is generated from the real Flow compiler, whose own CI
    // asserts the same artifact and provider-input hashes. Neither CI needs
    // production credentials or access to the other private repository.
    const id='10000000-0000-4000-8000-000000000001';
    const artifact={compilerVersion:'1',digestVersion:3,jobContext:{title:'Backend Engineer',location:'Bengaluru, India',
      jdDigest:JSON.stringify({topSkills:['Python'],seniorityLevel:'senior',domain:'Software',constraints:[],keyResponsibilities:[],titleSearchTerms:['backend engineer'],
        adjacentBuckets:[['Platform Engineer']],adjacentLocations:[],tokenCount:80,version:3}),skills:['Python'],goodToHaveSkills:[]},
      criterionMap:[{criterionId:id,use:'assessment',field:null}],previewQueryHash:'793684637894a3c147d660530f7be6ba1e589eec33a4552140ecec82cfc53148',
      briefVersionId:id,materialHash:'a'.repeat(64),sourceHash:'11a569574a6fae08fd44560a822f35b60f66ad61132624b10877f018e5e37183',
      digestBasisHash:'20d023c1977b18d86a8ee66021b85c1cf03dcfe28f29e89c79de8bc7def1b339',queryHash:'2b087666c7f77b9c59d08ac15ab6a1f9a94db97300e808b0c388169b37c4015b'};
    const parsed=governedSourceSchema.parse({protocolVersion:1,flowRunId:id,organizationRef:'28',externalJobId:'vanta:jobs:147',
      briefVersionId:id,materialHash:'a'.repeat(64),artifactHash:artifact.queryHash,compilerVersion:'1',queryArtifact:artifact,callbackUrl:'https://flow.example/api/webhooks/signal/callback'});
    const requirements=buildJobRequirements(parsed.queryArtifact.jobContext);
    expect(buildCrustdataRequestFingerprint({requirements,limit:300,excludePersonIds:[7,3,7]}))
      .toBe('cc2b39ef50c158e1400ddbf101356c9227d2cedc19ae995cb9572dd2b8993fae');
  });
  const cases = [
    {name:'exact with exclusions',requirements:common,excluded:[3,7],limit:300},
    {name:'title normalization and six-term cap',requirements:{...common,titleSearchTerms:['x',' one ','TWO','three','four','five','six','seven']},excluded:[],limit:300},
    {name:'legacy static family',requirements:{...common,titleSearchTerms:[]},excluded:[],limit:300},
    {name:'legacy skill fallback',requirements:{...common,titleSearchTerms:[],roleFamily:'unmapped'},excluded:[],limit:300},
    {name:'adjacent seniority spill',requirements:{...common,querySeniorityLevels:['mid','senior','lead']},excluded:[11,12],limit:43},
    {name:'country and unknown seniority',requirements:{...common,location:'India',seniorityLevel:'unmapped'},excluded:[],limit:300},
  ];
  for(const fixture of cases) it(fixture.name,async()=>{
    const old=await pinnedRequest(fixture.requirements,fixture.excluded,fixture.limit);
    expect(buildCrustdataRequest(fixture.requirements,fixture.limit,{excludePersonIds:fixture.excluded}).requestBody)
      .toEqual(JSON.parse(old.body));
    expect(old.headers['x-api-version']).toBe('2025-11-01');
  });
  it('preview changes only count/fields, never the exact searchable filters',async()=>{
    const old=JSON.parse((await pinnedRequest(common,[],300)).body);
    expect(buildCrustdataPreviewRequest(common)).toEqual({...old,limit:1,fields:['crustdata_person_id']});
  });
});

// Explicit peer-worktree input in the cross-system gate; ordinary unit runs do
// not assume an absolute checkout path or silently download another repository.
describe.skipIf(!process.env.FLOW_SOURCING_COMPILER_PATH)('actual Flow authority versus Discover query and receipt builders',()=>{
  let flow:{
    compileSourcingQuery:(basis:unknown,digest:unknown,basisHash:string)=>{jobContext:SourcingJobContextInput;queryHash:string};
    digestBasisHash:(basis:unknown)=>string;
    validateProviderGrant:(artifact:unknown,command:unknown,exact:unknown)=>{providerInputHash:string};
  };
  beforeAll(async()=>{flow=await import(process.env.FLOW_SOURCING_COMPILER_PATH!);});
  const id='10000000-0000-4000-8000-000000000001';
  for(const location of ['Bengaluru, India','Greater Bangalore Area','Seattle, WA','Unknown market'])it(`all permitted rungs: ${location}`,()=>{
    const source='Build Python and Node.js services.';
    const basis={briefVersionId:id,materialHash:'a'.repeat(64),sourceHash:governedHash(source),sourceJD:source,title:'Backend Engineer',location,
      payload:{schemaVersion:1,compilerVersion:1,taxonomyVersion:1,criteria:[{id,label:'Node.js',class:'must_have',subject:'skill',
        requirement:{kind:'text',value:'nodejs'},evidenceKinds:['profile_evidence'],use:'assessment',provenance:{kind:'recruiter_edit'}}]}};
    // sourceHash hashes the source bytes, not their JSON encoding.
    basis.sourceHash=createHash('sha256').update(source).digest('hex');
    const digest={version:3,topSkills:['nodejs'],seniorityLevel:'senior',domain:'Software',constraints:[],keyResponsibilities:[],
      titleSearchTerms:['Backend Engineer','API Engineer'],adjacentBuckets:[['Platform Engineer','Platform Engineer']],
      adjacentLocations:[{metro:'Mumbai',country:'India'},{metro:'New York',country:'USA'}],tokenCount:80};
    const artifact=flow.compileSourcingQuery(basis,digest,flow.digestBasisHash(basis));
    const requirements=buildJobRequirements(artifact.jobContext);
    const rungs=buildRelaxationRungs(requirements,deriveCountryCodeFromLocationText(location),deriveCountryCodeFromLocationText,10);
    for(const rung of rungs){
      const input={requirements:rung.requirements,limit:rung.id==='exact'?300:43,excludePersonIds:[7,3,7]};
      const command={action:'grant',protocolVersion:1,flowRunId:id,artifactHash:artifact.queryHash,discoverRequestId:id,executionAttemptId:id,
        slot:rung.id==='exact'?'exact':'spill',rungId:rung.id,providerInput:buildCrustdataRequestInput(input)};
      expect(flow.validateProviderGrant(artifact,command,rung.id==='exact'?null:{providerTotal:280,rawReturnedCount:257}).providerInputHash)
        .toBe(buildCrustdataRequestFingerprint(input));
    }
  });
});
