import {describe,expect,it} from 'vitest';
import {adaptProfile,OversizedEvidenceError} from '../../rubric/evidence';
import {rankingHash} from '../../rubric/contracts';
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
