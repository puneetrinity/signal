import {canonical, rankingHash} from '../rubric/contracts';
import type {RcBaseline} from './repository';

/** Input has passed rcBaselineSchema. Array order is part of the commitment. */
export function encodeRcPreparation(baseline:RcBaseline,receiptIds:string[]) {
 return {version:1 as const,transportVersion:1 as const,receiptIds,
  baselineHash:rankingHash(baseline),asOf:baseline.asOf,baselineTransport:{
   version:1 as const,asOf:baseline.asOf,
   evidenceCanonical:baseline.evidence.map(canonical),
   withheldCanonical:baseline.withheld.map(canonical),
   identitiesCanonical:baseline.identities.map(canonical),
   cacheCanonical:baseline.cache.map(canonical),
  }};
}
