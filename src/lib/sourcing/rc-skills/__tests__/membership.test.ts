import {describe,it,expect} from 'vitest';
import {deriveRcPurchaseMembers,rcPublicIdentities,type RcPurchaseReceipt} from '../membership';
const url=(n:number)=>`https://linkedin.com/in/person-${n}`;
const profile=(n:number)=>({social_handles:{professional_network_identifier:{profile_url:url(n)}}});
const identities=(count:number)=>rcPublicIdentities(Array.from({length:count},(_,n)=>({candidateId:`c${n}`,
  globalCandidateId:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,url:url(n)})));
const receipt=(count:number,start=0,slot:'exact'|'spill'='exact'):RcPurchaseReceipt=>({id:slot,tenantId:'org_1',sourcingRequestId:'request',
  acquisitionGeneration:1,slot,status:'complete',result:{profiles:Array.from({length:count},(_,n)=>profile(start+n))}});
const derive=(receipts:RcPurchaseReceipt[],count=2000)=>deriveRcPurchaseMembers({tenantId:'org_1',requestId:'request',generation:1,receipts,identities:identities(count)});
describe('receipt-derived RC membership',()=>{
  it.each([0,1,299,300])('admits %i newly bought identities, never Memory-only backlog',count=>{
    expect(derive([receipt(count)]).length).toBe(count);
  });
  it('deduplicates exact/spill overlap without inspecting source or scores',()=>{
    const result=derive([receipt(150,100,'spill'),receipt(200)]);
    expect(result.length).toBe(250);
    expect(result.find(v=>v.candidateId==='c150')?.receiptId).toBe('exact');
    expect(derive([receipt(200),receipt(150,100,'spill')])).toEqual(result);
  });
  it('refuses a 301-person receipt union even if only one person materialized',()=>{
    expect(()=>derive([receipt(300),receipt(1,300,'spill')],1)).toThrow('RC_PURCHASE_LIMIT');
  });
  it.each([{tenantId:'org_2'},{sourcingRequestId:'other'},{acquisitionGeneration:2},{status:'started'},
    {status:'uncertain'},{slot:'other'}])('refuses a mismatched receipt %j',patch=>{
    expect(()=>derive([{...receipt(1),...patch} as RcPurchaseReceipt])).toThrow('RC_RECEIPT_BINDING_CONFLICT');
  });
  it('refuses duplicate slots and IDs',()=>{
    expect(()=>derive([receipt(1),{...receipt(1),id:'another'}])).toThrow();
    expect(()=>derive([receipt(1),{...receipt(1,1,'spill'),id:'exact'}])).toThrow();
  });
  it('does not authorize a call from an unanchored or invalid receipt profile',()=>{
    const row=receipt(0);row.result={profiles:[{email:'ignored'}, {social_handles:{professional_network_identifier:{profile_url:'https://other.invalid/in/x'}}}]};
    expect(derive([row])).toEqual([]);
  });
  it('normalizes the existing public identity and refuses conflicting bindings',()=>{
    const row={candidateId:'c',globalCandidateId:'abcdefab-1234-4123-8123-abcdefabcdef',url:'https://www.linkedin.com/in/Person-1/?x=1'};
    expect(rcPublicIdentities([row])[0].url).toBe(url(1));
    expect(()=>rcPublicIdentities([row,{...row,candidateId:'other'}])).toThrow('RC_IDENTITY_CONFLICT');
    expect(()=>deriveRcPurchaseMembers({tenantId:'org_1',requestId:'request',generation:1,receipts:[receipt(1)],
      identities:[{...identities(1)[0],identityHash:'0'.repeat(64)}]})).toThrow('RC_IDENTITY_CONFLICT');
  });
});
