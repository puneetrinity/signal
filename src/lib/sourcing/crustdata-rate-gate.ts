import { randomUUID } from 'node:crypto';

/** Only raised before the provider transport is invoked. Never infer this
 * classification from a timeout or an HTTP error after dispatch. */
export class CrustdataNoDispatchError extends Error {
  constructor() { super('CRUSTDATA_NO_DISPATCH'); }
}

// One key slot and one server clock for all users of the account. A successful
// permit is spent even if the subsequent HTTP request fails. No local fallback.
export const CRUSTDATA_RATE_LUA = `
local clock = redis.call('TIME')
local now = tonumber(clock[1])*1000 + math.floor(tonumber(clock[2])/1000)
local mode = ARGV[1]
local request = ARGV[2]
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now-60000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now-60000)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now-30000)
if redis.call('ZSCORE', KEYS[1], request) then return {0, 60000, 'duplicate'} end
if mode == 'acquisition' then
  redis.call('ZADD', KEYS[3], now, request)
  redis.call('PEXPIRE', KEYS[3], 120000)
elseif mode ~= 'preview' then
  return {0, 60000, 'invalid'}
end
if mode == 'preview' and redis.call('ZCARD', KEYS[3]) > 0 then return {0, 1000, 'priority'} end
local all = redis.call('ZCARD', KEYS[1])
local previews = redis.call('ZCARD', KEYS[2])
if all >= 30 or (mode == 'preview' and previews >= 6) then
  local key = KEYS[1]
  if mode == 'preview' and previews >= 6 then key = KEYS[2] end
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {0, math.max(1, 60000-tonumber(now-oldest[2])), 'limit'}
end
redis.call('ZADD', KEYS[1], now, request)
redis.call('PEXPIRE', KEYS[1], 120000)
if mode == 'preview' then
  redis.call('ZADD', KEYS[2], now, request)
  redis.call('PEXPIRE', KEYS[2], 120000)
else redis.call('ZREM', KEYS[3], request) end
return {1, 0, 'allowed'}
`;

export interface RateGateRedis {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}
export type RateGateResult = { allowed: boolean; retryAfterMs: number; reason: 'allowed' | 'priority' | 'limit' | 'duplicate' };

export async function takeCrustdataPermit(redis: RateGateRedis, kind: 'acquisition' | 'preview', requestId = randomUUID()): Promise<RateGateResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('CRUSTDATA_RATE_INVALID_REQUEST');
  let raw: unknown;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    raw = await Promise.race([redis.eval(CRUSTDATA_RATE_LUA, 3,
      '{crustdata}:rate:all', '{crustdata}:rate:preview', '{crustdata}:rate:acquisition-waiting', kind, requestId),
      new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),2000);})]);
  } catch { throw new Error('CRUSTDATA_RATE_UNAVAILABLE'); }
  finally {if(timer)clearTimeout(timer);}
  if (!Array.isArray(raw) || raw.length !== 3 || ![0, 1].includes(raw[0]) ||
      !Number.isSafeInteger(raw[1]) || raw[1] < 0 || raw[1] > 60000 ||
      !['allowed','priority','limit','duplicate'].includes(raw[2]) ||
      (raw[0] === 1) !== (raw[2] === 'allowed')) throw new Error('CRUSTDATA_RATE_UNAVAILABLE');
  return { allowed: raw[0] === 1, retryAfterMs: raw[1], reason: raw[2] };
}

/** Account capacity precedes the per-run grant. Waiting never authorizes an
 * HTTP retry; one permit covers one dispatch even when its outcome is unknown.
 * Poll at most once a second to keep acquisition priority fresh in Redis. */
export async function waitForCrustdataAcquisition(redis:RateGateRedis,
  dependencies:{now?:()=>number;sleep?:(ms:number)=>Promise<void>}={}) {
  const now=dependencies.now??(()=>performance.now());
  const sleep=dependencies.sleep??((ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
  const deadline=now()+65000,requestId=randomUUID();
  for(let polls=0;polls<66;polls++) {
    if(now()>=deadline)break;
    const permit=await takeCrustdataPermit(redis,'acquisition',requestId);
    if(permit.allowed)return;
    if(permit.reason==='duplicate')throw Error('CRUSTDATA_RATE_UNCERTAIN');
    await sleep(Math.min(Math.max(permit.retryAfterMs,1),1000,Math.max(0,deadline-now())));
  }
  throw Error('CRUSTDATA_RATE_BUSY');
}

export async function acquireCrustdataAccountCapacity() {
  if(!process.env.REDIS_URL)throw Error('CRUSTDATA_RATE_CONFIGURATION');
  const {getRedisConnection}=await import('./queue/producer');
  await waitForCrustdataAcquisition(getRedisConnection());
}
