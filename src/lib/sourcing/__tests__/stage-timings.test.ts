import {describe,it,expect} from 'vitest';
import {SourcingTimings,withSourcingTimings,currentSourcingTimings,measureSourcingStage,timedSourcingFunction,SOURCING_STAGES} from '../stage-timings';

describe('bounded sourcing measurements',()=>{
  it('preserves values, errors and call counts without storing payloads',async()=>{
    let clock=0; const recorder=new SourcingTimings(()=>clock);
    const value={secret:'candidate payload'},error=Error('provider body / key');
    expect(await recorder.measure('exclusions',async()=>{clock=10;return value;})).toBe(value);
    await expect(recorder.measure('exclusions',async()=>{clock=15;throw error;})).rejects.toBe(error);
    expect(recorder.snapshot().stages.exclusions).toEqual({calls:2,failures:1,totalMs:15,maxMs:10,firstStartMs:0,lastEndMs:15});
    expect(JSON.stringify(recorder.snapshot())).not.toMatch(/secret|candidate payload|provider body/);
  });
  it('records overlapping intervals, not a fabricated sequential sum',async()=>{
    let clock=0,release!:()=>void; const recorder=new SourcingTimings(()=>clock);
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const first=recorder.measure('memory_public',async()=>gate);
    clock=5;
    await recorder.measure('memory_private',async()=>{clock=10;});
    clock=20;release();await first;
    expect(recorder.snapshot()).toMatchObject({elapsedMs:20,stages:{
      memory_public:{totalMs:20,firstStartMs:0,lastEndMs:20},
      memory_private:{totalMs:5,firstStartMs:5,lastEndMs:10}}});
  });
  it('isolates simultaneous jobs and does nothing outside a worker context',async()=>{
    expect(currentSourcingTimings()).toBeUndefined();
    expect(await measureSourcingStage('rc_tick',async()=>42)).toBe(42);
    const results=await Promise.all(['memory_public','rc_tick'].map(stage=>withSourcingTimings(async()=>{
      await measureSourcingStage(stage as 'rc_tick',async()=>Promise.resolve());
      return currentSourcingTimings();
    })));
    expect(Object.keys(results[0]!.stages)).toEqual(['memory_public']);
    expect(Object.keys(results[1]!.stages)).toEqual(['rc_tick']);
    expect(currentSourcingTimings()).toBeUndefined();
  });
  it('preserves function arguments, executes once and returns an isolated snapshot',async()=>{
    await withSourcingTimings(async()=>{
      let calls=0;
      const wrapped=timedSourcingFunction('rc_preparation',async(a:number,b:string)=>{calls++;return `${a}${b}`;});
      expect(await wrapped(4,'x')).toBe('4x');expect(calls).toBe(1);
      currentSourcingTimings()!.stages.rc_preparation!.calls=999;
      expect(currentSourcingTimings()!.stages.rc_preparation!.calls).toBe(1);
    });
  });
  it('keeps the full fixed-stage payload small even after repeated measurements',async()=>{
    let clock=0;const recorder=new SourcingTimings(()=>clock);
    for(const stage of SOURCING_STAGES)for(let i=0;i<20;i++)await recorder.measure(stage,async()=>{clock+=100;});
    expect(Buffer.byteLength(JSON.stringify(recorder.snapshot()))).toBeLessThan(4096);
    clock=1e12;expect(recorder.snapshot().elapsedMs).toBe(86_400_000);
  });
});
