import {createHash} from 'node:crypto';
import {canonical} from '../rubric/contracts';
import type {RcBaseline} from './repository';

/** Input has passed rcBaselineSchema. Array order is part of the commitment. */
export function encodeRcPreparation(baseline:RcBaseline,receiptIds:string[]) {
 const baselineTransport={version:1 as const,asOf:baseline.asOf,
  evidenceCanonical:baseline.evidence.map(canonical),
  withheldCanonical:baseline.withheld.map(canonical),
  identitiesCanonical:baseline.identities.map(canonical),
  cacheCanonical:baseline.cache.map(canonical)};
 // Same canonical object bytes, streamed from the already encoded records.
 // Array order is preserved; there is no second walk of every profile/fact.
 const hash=createHash('sha256').update('{"asOf":').update(canonical(baseline.asOf));
 const array=(name:string,values:string[])=>{
  hash.update(',"'+name+'":[');
  for(let i=0;i<values.length;i++){if(i)hash.update(',');hash.update(values[i]);}
  hash.update(']');
 };
 array('cache',baselineTransport.cacheCanonical);array('evidence',baselineTransport.evidenceCanonical);
 array('identities',baselineTransport.identitiesCanonical);hash.update(',"version":1');
 array('withheld',baselineTransport.withheldCanonical);hash.update('}');
 return {version:1 as const,transportVersion:1 as const,receiptIds,
  baselineHash:hash.digest('hex'),asOf:baseline.asOf,baselineTransport};
}
