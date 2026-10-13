import {describe,expect,it} from 'vitest';
import {adaptProfile,evidenceBytes,EVIDENCE_MAX_BYTES,OversizedEvidenceError} from '../../rubric/evidence';
import {rankingHash,byteCompare} from '../../rubric/contracts';
import {createObservation} from '../contracts';
import {addRcSkills} from '../evidence';
const now='2026-10-08T00:00:00.000Z',identityHash=rankingHash('synthetic-public-identity');
const observation=(skills=['AWS'])=>createObservation({
  version:1,outcome:'success',identityHash,skills,upstreamAt:now,observedAt:now,
  validUntil:new Date(Date.parse(now)+1095*86400000).toISOString(),timestampSource:'check_last_update',
});
const baseline=()=>adaptProfile({candidateId:'synthetic',organizationRef:'1',sourceVersion:'synthetic-profile',observedAt:now,
  profile:{skills:['Java']},permittedFacts:[{
    field:'skill',value:'Kafka',ref:'candidate.skills',kind:'candidate_provided',
    scope:'organization',organizationRef:'1',sourceVersion:'candidate-v1',observedAt:now,
  }]});
describe('RC evidence union',()=>{
  it('preserves the legacy fact order and hash with duplicates, private facts and employment',()=>{
    const obs=observation(['AWS','aws','日本語','Größe','C++']);
    const original=baseline();
    original.employment=[{title:'Senior Engineer',start:'2020-01',end:null,ongoing:true}];
    original.facts[1]={...original.facts[1],qualifier:'confirmed',revoked:false};
    original.facts.push({...original.facts[0]});
    const before=structuredClone({original,obs});
    const additions=['aws','aws','日本語','größe','c++'].map(value=>({
      field:'skill' as const,value,ref:'profile.skills',kind:'profile_evidence' as const,
      scope:'public' as const,organizationRef:null,sourceVersion:obs.contentHash,
      observedAt:obs.observedAt,validUntil:obs.validUntil!,
    }));
    const facts=[...new Map([...original.facts,...additions].map(fact=>[rankingHash(fact),fact])).values()]
      .sort((a,b)=>byteCompare(rankingHash(a),rankingHash(b)));
    const expected={...original,facts};
    const result=addRcSkills(original,obs,identityHash,now);
    expect(result).toEqual(expected);
    expect(rankingHash(result)).toBe(rankingHash(expected));
    expect(addRcSkills({...original,facts:[...original.facts].reverse()},obs,identityHash,now)).toEqual(result);
    expect(addRcSkills(result,obs,identityHash,now)).toEqual(result);
    expect({original,obs}).toEqual(before);
  });
  it.each([EVIDENCE_MAX_BYTES-1,EVIDENCE_MAX_BYTES,EVIDENCE_MAX_BYTES+1])(
    'preserves exact enriched byte boundary at %i bytes',target=>{
      const original=baseline(),obs=observation();
      const expected=addRcSkills(original,obs,identityHash,now);
      const bytes=()=>evidenceBytes({...expected,presentationSource:'pool_enriched'});
      while(target-bytes()>520)expected.employment.push({title:'x'.repeat(500)});
      expected.employment.push({title:''});
      const remaining=target-bytes();
      expect(remaining).toBeGreaterThanOrEqual(0);
      expect(remaining).toBeLessThanOrEqual(500);
      expected.employment[expected.employment.length-1].title='x'.repeat(remaining);
      original.employment=structuredClone(expected.employment);
      expect(bytes()).toBe(target);
      const before=structuredClone(original);
      if(target<=EVIDENCE_MAX_BYTES){
        expect(addRcSkills(original,obs,identityHash,now)).toEqual(expected);
      }else{
        let error:unknown;
        try{addRcSkills(original,obs,identityHash,now);}catch(e){error=e;}
        expect(error).toBeInstanceOf(OversizedEvidenceError);
        expect((error as OversizedEvidenceError).record).toEqual({candidateId:original.candidateId,
          reason:'evidence_too_large',evidenceHash:rankingHash(expected),bytes:target,limit:EVIDENCE_MAX_BYTES});
      }
      expect(original).toEqual(before);
    });
  it('preserves all prior facts and adds only public profile skill facts',()=>{
    const original=baseline(),result=addRcSkills(original,observation(),identityHash,now);
    expect(result.facts).toEqual(expect.arrayContaining(original.facts));
    expect(result.facts.find(f=>f.value==='aws')).toMatchObject({
      field:'skill',kind:'profile_evidence',scope:'public',organizationRef:null,ref:'profile.skills',
    });
    expect(baseline()).toEqual(original);
    expect(addRcSkills(result,observation(),identityHash,now)).toEqual(result);
  });
  it('never attaches another identity or another organization evidence',()=>{
    expect(()=>addRcSkills(baseline(),observation(),'b'.repeat(64),now)).toThrow('IDENTITY_CONFLICT');
    const original=baseline();
    expect(()=>addRcSkills({...original,organizationRef:'2'},observation(),identityHash,now)).toThrow();
  });
  it('does not renew stale observations or count no-data as skill evidence',()=>{
    const original=baseline(),obs=observation();
    const expired=new Date(Date.parse(obs.validUntil!)+1).toISOString();
    expect(addRcSkills(original,obs,identityHash,expired)).toEqual(original);
    const empty=createObservation({version:1,outcome:'no_skills',identityHash,skills:[],
      upstreamAt:now,observedAt:now,validUntil:null,timestampSource:'check_last_update'});
    expect(addRcSkills(original,empty,identityHash,now)).toEqual(original);
  });
  it('withholds an oversized enriched person rather than trimming skills',()=>{
    const obs=observation(Array.from({length:500},(_,i)=>'skill-'+i+'x'.repeat(50)));
    expect(()=>addRcSkills(baseline(),obs,identityHash,now)).toThrow(OversizedEvidenceError);
    expect(baseline().facts).toHaveLength(2);
  });
});
