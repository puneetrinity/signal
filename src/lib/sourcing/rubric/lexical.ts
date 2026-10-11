import type { Criterion } from './contracts';
import { normalize } from './taxonomy';
export const LOCAL_SCALE=1_000_000;
const tokens=(value:string)=>new Set(normalize(value).match(/[\p{L}\p{N}+#.]+/gu)??[]);
/** Only positive same-field evidence; never raw JD, resume, headline or provider scores. */
export function localMatch(criterion:Criterion,positiveValues:readonly string[]):number {
  if(!positiveValues.length) return 0;
  if(!['function','relevant_work','domain'].includes(criterion.subject)) return LOCAL_SCALE;
  if(criterion.requirement.kind!=='text') return 0;
  const query=tokens(criterion.requirement.value),evidence=new Set(positiveValues.flatMap(v=>[...tokens(v)]));
  return query.size?Math.floor(LOCAL_SCALE*[...query].filter(t=>evidence.has(t)).length/query.size):0;
}
