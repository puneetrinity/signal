import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mapper} from './production.mjs';
import {TARGET} from './core.mjs';
test('exact source mapper and real packet builder: snapshot skill guesses do not affect Memory bytes',async()=>{
  const saved=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('NO_NETWORK_IN_TEST');};
  try{
    const {buildObservedCandidatePublicMarket,resolvePublicCandidateRoleFamily}=await import('../../src/lib/sourcing/public-memory-materialization.ts');
    const {extractLinkedInIdFromUrl}=await import('../../src/lib/sourcing/discovery.ts');
    const {prepareMemoryPacket}=await import('../../src/lib/sourcing/immutable-memory-ingest.ts');
    const profiles=[{crustdata_person_id:123,flagship_profile_url:'https://linkedin.com/in/synthetic-123',
      basic_profile:{name:'Synthetic Engineer',headline:'Python Engineer',location:{city:'Bengaluru',country:'India'}},
      experience:{employment_details:{current:[{title:'Backend Engineer',name:'Synthetic',description:'Built Python services'}],past:[]}}}];
    const fn=new Function('crustProfiles','requirements','acquisitionRungByProfile','buildObservedCandidatePublicMarket',
      'resolvePublicCandidateRoleFamily','extractLinkedInIdFromUrl',mapper(readFileSync('src/lib/sourcing/orchestrator.ts','utf8')));
    const map=topSkills=>fn(profiles,{topSkills},new Map(),buildObservedCandidatePublicMarket,resolvePublicCandidateRoleFamily,extractLinkedInIdFromUrl);
    const noSkills=map([]),withSkills=map(['Python']);
    assert.equal(noSkills.length,1);assert.equal(noSkills[0].snapshot,null);assert.ok(withSkills[0].snapshot);
    const owner={tenantId:TARGET.tenantId,sourcingRequestId:TARGET.requestId,acquisitionReceiptId:TARGET.purchaseId,acquisitionGeneration:1,acquisitionSlot:'exact'};
    const packet=c=>prepareMemoryPacket(owner,c,{...owner,acquiredAt:new Date('2026-10-19T00:00:00Z'),
      profileObservedAt:new Date('2026-10-19T00:00:00Z'),expectedGlobalCandidateId:null,publicMarket:c.publicMarket,publicCandidateRoleFamily:c.publicCandidateRoleFamily});
    assert.equal(packet(noSkills[0]).requestBody,packet(withSkills[0]).requestBody);
    assert.equal(calls,0);
  }finally{globalThis.fetch=saved;}
});
