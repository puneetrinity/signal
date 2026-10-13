/** Only a committed, typed busy response is safe to retry. Never retry an
 * exception: it may follow a committed claim/publication or unknown dispatch. */
export const RANKING_RETRY={elapsedMs:20_000,maxBusy:8,maxReprepare:3} as const;
export type RetryClock={now:()=>number;sleep:(ms:number)=>Promise<void>;random:()=>number};
const clock:RetryClock={now:Date.now,sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),random:Math.random};
export async function retryRankingBusy<T>(phase:'claim'|'finish',run:()=>Promise<T>,time:RetryClock=clock):Promise<T>{
 const start=time.now();
 for(let busy=0;;busy++){
  const value=await run();
  if(!value||typeof value!=='object'||(value as {state?:unknown}).state!=='busy')return value;
  const response=value as Record<string,unknown>;
  if(response.phase!==phase||Object.keys(response).sort().join(',')!=='phase,state')throw Error('RANKING_INVALID_BUSY');
  const delay=[250,500,1000][busy]??2000;
  const wait=delay+Math.floor(Math.max(0,Math.min(1,time.random()))*250);
  if(busy+1>=RANKING_RETRY.maxBusy||time.now()-start+wait>=RANKING_RETRY.elapsedMs)throw Error('RANKING_CONTENTION_EXHAUSTED');
  await time.sleep(wait);
  if(time.now()-start>=RANKING_RETRY.elapsedMs)throw Error('RANKING_CONTENTION_EXHAUSTED');
 }
}
