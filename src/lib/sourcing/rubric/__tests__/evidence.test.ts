import {describe,it,expect} from 'vitest';
import {adaptProfile,evidenceFor,evidenceBytes,evidenceSchema,EVIDENCE_MAX_BYTES,EVIDENCE_POOL_MAX_BYTES,OversizedEvidenceError,type EvidenceFact} from '../evidence';
const asOf='2025-01-01T00:00:00.000Z';
const base={candidateId:'a',organizationRef:'1',sourceVersion:'test',observedAt:asOf};
const fact=(value:string,scope:EvidenceFact['scope']='organization'):EvidenceFact=>({field:'city',value,ref:'candidate.city',kind:'candidate_provided',
  sourceVersion:'v1',observedAt:asOf,scope,organizationRef:scope==='organization'?'1':null});
describe('scoped minimal evidence',()=>{
  it('keeps an RC-shaped skills list and long career without trimming',()=>{
    const skills=Array.from({length:80},(_,i)=>`skill ${i}`);
    const past=Array.from({length:19},()=>({title:'Backend Engineer',start_date:'2010-01-01',end_date:'2011-01-01'}));
    const e=adaptProfile({...base,profile:{skills:{professional_network_skills:skills},experience:{employment_details:{past}}}});
    expect(e.employment).toHaveLength(19);expect(e.facts.filter(f=>f.field==='skill')).toHaveLength(80);
    expect(evidenceBytes({...e,presentationSource:'pool_enriched'})).toBeLessThanOrEqual(EVIDENCE_MAX_BYTES);
  });
  it('classifies only valid oversized evidence with a sealed hash, never malformed or private evidence',()=>{
    const skills=Array.from({length:250},(_,i)=>`skill ${i} ${'x'.repeat(150)}`);
    let error:unknown;
    try{adaptProfile({...base,profile:{skills:{professional_network_skills:skills}}});}catch(e){error=e;}
    expect(error).toBeInstanceOf(OversizedEvidenceError);
    expect((error as OversizedEvidenceError).record).toMatchObject({candidateId:'a',reason:'evidence_too_large',limit:65536});
    expect((error as OversizedEvidenceError).record.bytes).toBeGreaterThan(65536);
    expect((error as OversizedEvidenceError).record.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    try{adaptProfile({...base,profile:{skills:{professional_network_skills:skills}},permittedFacts:[{...fact('Pune'),organizationRef:'foreign'}]});throw Error('accepted');}
    catch(e){expect(e).not.toBeInstanceOf(OversizedEvidenceError);expect(String(e)).not.toBe('Error: accepted');}
  });
  it('uses spaced JSON bytes, accepts the exact limit and refuses one byte over',()=>{
    const e=adaptProfile({...base,profile:{}});
    const facts=Array.from({length:150},()=>({...fact('x'),value:'x'.repeat(100)}));
    const sized={...e,facts};
    while(evidenceBytes(sized)<65536){
      const room=65536-evidenceBytes(sized),f=facts.find(f=>f.value.length<500);
      if(!f)throw Error('fixture capacity');f.value+='x'.repeat(Math.min(room,500-f.value.length));
    }
    expect(evidenceBytes(sized)).toBe(65536);expect(evidenceSchema.safeParse(sized).success).toBe(true);
    facts.find(f=>f.value.length<500)!.value+='x';expect(evidenceSchema.safeParse(sized).success).toBe(false);
    // 2000 maximum-sized items plus separators and bounded command fields fit.
    expect(2000*(65536+2)+4096).toBeLessThan(EVIDENCE_POOL_MAX_BYTES);
  });
  it('measures a 2000-person near-cap command without constructing another aggregate JSON string',()=>{
    const e={...adaptProfile({...base,profile:{}}),facts:Array.from({length:100},()=>({...fact('x'),value:'x'.repeat(420)}))};
    expect(evidenceBytes(e)).toBeLessThanOrEqual(EVIDENCE_MAX_BYTES);
    expect(evidenceBytes(e)).toBeGreaterThan(60000);
    const start=performance.now(),rss=process.memoryUsage().rss;
    const size=evidenceBytes({evidence:Array.from({length:2000},(_,i)=>({...e,candidateId:String(i)})),withheld:[]});
    expect(size).toBeGreaterThan(120_000_000);expect(size).toBeLessThan(EVIDENCE_POOL_MAX_BYTES);
    console.info('V16 aggregate sizing',JSON.stringify({bytes:size,elapsedMs:Math.round(performance.now()-start),rssDelta:process.memoryUsage().rss-rss}));
  },20000);
  it('omits names, headline, contacts, legacy text-extracted skills and total-year hints',()=>{
    const e=adaptProfile({...base,profile:{basic_profile:{name:'PRIVATE',headline:'Java',email:'secret'},years_of_experience_raw:20,
      snapshot:{skillsNormalized:['Java']},summary:'Kafka expert'}});
    expect(e.facts).toEqual([]);expect(e.employment).toEqual([]);expect(JSON.stringify(e)).not.toContain('PRIVATE');
  });
  it('accepts only structured skills and keeps source metadata',()=>{
    const e=adaptProfile({...base,profile:{skills:{professional_network_skills:['Golang']}}});
    expect(e.facts[0]).toMatchObject({field:'skill',value:'golang',sourceVersion:'test',scope:'public'});
  });
  it('candidate evidence outranks provider observation without becoming public',()=>{
    const e=adaptProfile({...base,profile:{basic_profile:{location:{city:'Pune'}}},permittedFacts:[fact('Bengaluru')]});
    expect(evidenceFor(e,'city',['profile_evidence','candidate_provided'],asOf)).toEqual([fact('Bengaluru')]);
    expect(()=>adaptProfile({...base,profile:{},permittedFacts:[{...fact('Pune'),organizationRef:'2'}]})).toThrow();
  });
  it('same-precedence singleton conflicts and future observations remain unknown',()=>{
    const e=adaptProfile({...base,profile:{},permittedFacts:[fact('Pune'),fact('Bengaluru')]});
    expect(evidenceFor(e,'city',['candidate_provided'],asOf)).toEqual([]);
    const later=adaptProfile({...base,profile:{},permittedFacts:[{...fact('Pune'),observedAt:'2026-01-01T00:00:00Z'}]});
    expect(evidenceFor(later,'city',['candidate_provided'],asOf)).toEqual([]);
  });
});
