import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {randomUUID} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import Redis from 'ioredis';
import { CRUSTDATA_RATE_LUA, takeCrustdataPermit,waitForCrustdataAcquisition } from '../crustdata-rate-gate';
const id = '10000000-0000-4000-8000-000000000001';
describe('shared Crustdata rate gate', () => {
  afterEach(()=>vi.useRealTimers());
  it('uses the Redis clock, shared account keys and one atomic script', async () => {
    const evalFn = vi.fn().mockResolvedValue([1, 0, 'allowed']);
    expect(await takeCrustdataPermit({ eval: evalFn }, 'acquisition', id)).toEqual({ allowed: true, retryAfterMs: 0, reason: 'allowed' });
    expect(evalFn).toHaveBeenCalledWith(CRUSTDATA_RATE_LUA, 3, '{crustdata}:rate:all', '{crustdata}:rate:preview', '{crustdata}:rate:acquisition-waiting', 'acquisition', id);
    expect(CRUSTDATA_RATE_LUA).toContain("redis.call('TIME')");
  });
  it('fails closed on missing Redis, noop clients or malformed replies', async () => {
    for (const raw of [null, undefined, [], 'OK', [1, 0, 'limit'], [0, -1, 'limit'], [1, 0, 'allowed', 'extra']]) {
      await expect(takeCrustdataPermit({ eval: async () => raw }, 'preview', id)).rejects.toThrow('RATE_UNAVAILABLE');
    }
    await expect(takeCrustdataPermit({ eval: async () => { throw Error('connection'); } }, 'preview', id)).rejects.toThrow('RATE_UNAVAILABLE');
  });
  it('returns explicit denial rather than sleeping or dispatching', async () => {
    expect(await takeCrustdataPermit({ eval: async () => [0, 1000, 'priority'] }, 'preview', id))
      .toEqual({ allowed: false, retryAfterMs: 1000, reason: 'priority' });
  });
  it('bounds an unresponsive Redis client',async()=>{
    vi.useFakeTimers();const result=takeCrustdataPermit({eval:()=>new Promise(()=>{})},'acquisition',id);
    const assertion=expect(result).rejects.toThrow('RATE_UNAVAILABLE');
    await vi.advanceTimersByTimeAsync(2000);await assertion;
  });
  it('refreshes acquisition priority under one identity while waiting',async()=>{
    let now=0;const evalFn=vi.fn().mockResolvedValueOnce([0,60000,'limit']).mockResolvedValueOnce([1,0,'allowed']);
    await waitForCrustdataAcquisition({eval:evalFn},{now:()=>now,sleep:async ms=>{now+=ms;}});
    expect(now).toBe(1000);expect(evalFn.mock.calls[0][6]).toBe(evalFn.mock.calls[1][6]);
  });
  it('bounded wait cannot silently turn a refusal into permission',async()=>{
    let now=0;const evalFn=vi.fn().mockResolvedValue([0,60000,'limit']);
    await expect(waitForCrustdataAcquisition({eval:evalFn},{now:()=>now,sleep:async ms=>{now+=ms;}})).rejects.toThrow('RATE_BUSY');
    expect(now).toBe(65000);expect(evalFn).toHaveBeenCalledTimes(65);
  });
});

describe.skipIf(process.env.SIGNAL_SOURCING_REDIS_DISPOSABLE!=='1')('rate gate on isolated real Redis',()=>{
  let clients:Redis[]=[];const marker=randomUUID();
  const keys=['{crustdata}:rate:all','{crustdata}:rate:preview','{crustdata}:rate:acquisition-waiting'];
  beforeAll(async()=>{
    const url=new URL(process.env.SIGNAL_SOURCING_REDIS_URL??'');
    if(url.protocol!=='redis:'||url.hostname!=='127.0.0.1'||!url.port||url.port==='6379'||!['','/','/0'].includes(url.pathname)) throw Error('ISOLATED_REDIS_REQUIRED');
    clients=Array.from({length:4},()=>new Redis(url.toString(),{connectTimeout:2000,maxRetriesPerRequest:0,retryStrategy:()=>null}));
    expect(await clients[0].dbsize()).toBe(0);
    expect(await clients[0].set('wave5b:disposable-owner',marker,'NX')).toBe('OK');
  });
  beforeEach(async()=>{
    if(await clients[0].get('wave5b:disposable-owner')!==marker)throw Error('REDIS_OWNERSHIP_CHANGED');
    await clients[0].del(...keys);
  });
  afterAll(async()=>{
    try{
      if(clients[0] && await clients[0].get('wave5b:disposable-owner')===marker) await clients[0].del(...keys,'wave5b:disposable-owner');
    }finally{await Promise.all(clients.map(c=>c.quit().catch(()=>c.disconnect())));}
  });
  it('permits exactly30 acquisitions across independent concurrent clients',async()=>{
    const attempts=await Promise.all(Array.from({length:50},(_,n)=>takeCrustdataPermit(clients[n%4],'acquisition')));
    expect(attempts.filter(a=>a.allowed)).toHaveLength(30);
    expect(await clients[0].zcard(keys[0])).toBe(30);
  });
  it('limits previews to6 but leaves remaining capacity for acquisitions',async()=>{
    const previews=await Promise.all(Array.from({length:20},(_,n)=>takeCrustdataPermit(clients[n%4],'preview')));
    expect(previews.filter(a=>a.allowed)).toHaveLength(6);
    const paid=await Promise.all(Array.from({length:30},(_,n)=>takeCrustdataPermit(clients[n%4],'acquisition')));
    expect(paid.filter(a=>a.allowed)).toHaveLength(24);
    expect(await clients[0].zcard(keys[0])).toBe(30);
  });
  it('lets a waiting acquisition go before previews when capacity reopens',async()=>{
    await Promise.all(Array.from({length:30},()=>takeCrustdataPermit(clients[0],'acquisition')));
    const waiting=randomUUID();expect((await takeCrustdataPermit(clients[1],'acquisition',waiting)).allowed).toBe(false);
    // Age the owned account entries rather than sleeping or replacing Redis's clock.
    const members=await clients[0].zrange(keys[0],0,-1);
    const [seconds]=await clients[0].time();
    for(const member of members)await clients[0].zadd(keys[0],Number(seconds)*1000-61000,member);
    expect(await takeCrustdataPermit(clients[2],'preview')).toMatchObject({allowed:false,reason:'priority'});
    expect(await takeCrustdataPermit(clients[1],'acquisition',waiting)).toMatchObject({allowed:true});
    expect(await takeCrustdataPermit(clients[2],'preview')).toMatchObject({allowed:true});
  });
  it('never gives a duplicate request another permit',async()=>{
    const request=randomUUID();expect((await takeCrustdataPermit(clients[0],'acquisition',request)).allowed).toBe(true);
    expect(await takeCrustdataPermit(clients[1],'acquisition',request)).toMatchObject({allowed:false,reason:'duplicate'});
    expect(await clients[0].zcard(keys[0])).toBe(1);
  });
  it('shares the thirty-per-minute ceiling across real worker processes',async()=>{
    const source=`import Redis from 'ioredis';import gate from './src/lib/sourcing/crustdata-rate-gate.ts';const {takeCrustdataPermit}=gate;
      const redis=new Redis(process.env.FIXTURE_REDIS,{maxRetriesPerRequest:0,retryStrategy:()=>null});
      try{let n=0;for(let i=0;i<15;i++)if((await takeCrustdataPermit(redis,'acquisition')).allowed)n++;
        process.stdout.write(JSON.stringify(n));}finally{await redis.quit();}`;
    const results=await Promise.all(Array.from({length:3},()=>promisify(execFile)(process.execPath,
      ['--import','tsx','--input-type=module','-e',source],{cwd:process.cwd(),timeout:20000,env:{PATH:process.env.PATH,NODE_ENV:'test',
        FIXTURE_REDIS:process.env.SIGNAL_SOURCING_REDIS_URL,NODE_OPTIONS:'--max-old-space-size=256',UV_THREADPOOL_SIZE:'1'}})));
    expect(results.reduce((sum,r)=>sum+Number(r.stdout),0)).toBe(30);
    expect(await clients[0].zcard(keys[0])).toBe(30);
  });
  it('retains a consumed permit when the worker dies before provider dispatch',async()=>{
    const request=randomUUID();
    const source=`import Redis from 'ioredis';import gate from './src/lib/sourcing/crustdata-rate-gate.ts';const {takeCrustdataPermit}=gate;
      const redis=new Redis(process.env.FIXTURE_REDIS,{maxRetriesPerRequest:0,retryStrategy:()=>null});
      const result=await takeCrustdataPermit(redis,'acquisition',process.env.FIXTURE_REQUEST);
      if(!result.allowed)process.exit(2);process.stdout.write('PERMIT_COMMITTED\\n');setInterval(()=>{},1000);`;
    const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source],{cwd:process.cwd(),
      env:{PATH:process.env.PATH,NODE_ENV:'test',FIXTURE_REDIS:process.env.SIGNAL_SOURCING_REDIS_URL,FIXTURE_REQUEST:request,
        NODE_OPTIONS:'--max-old-space-size=256',UV_THREADPOOL_SIZE:'1'},stdio:['ignore','pipe','pipe']});
    const exited=once(child,'exit');
    try{
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('CHILD_PERMIT_DEADLINE')),10000);
        let output='';child.stdout.on('data',chunk=>{output+=String(chunk);if(output.includes('PERMIT_COMMITTED')){clearTimeout(timer);resolve();}});
        child.once('error',error=>{clearTimeout(timer);reject(error);});
        child.once('exit',()=>{clearTimeout(timer);reject(Error('CHILD_EXITED_BEFORE_PERMIT'));});
      });
      child.kill('SIGKILL');await exited;
      expect(await takeCrustdataPermit(clients[1],'acquisition',request)).toMatchObject({allowed:false,reason:'duplicate'});
      expect(await clients[0].zcard(keys[0])).toBe(1);
    }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
  });
});
