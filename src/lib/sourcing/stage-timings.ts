import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

// Closed names only: never record arguments, provider replies or exception text.
export const SOURCING_STAGES = [
  'orchestration', 'memory_public', 'memory_private', 'exclusions',
  'crustdata_acquisition', 'crustdata_provider', 'memory_ingestion', 'rc_preparation', 'rc_tick', 'rc_wait',
  'rc_provider_check', 'rc_provider_fetch',
  'rc_merge', 'ranking_claim', 'ranking_finish', 'ranking_read',
  'ranking_prepare', 'ranking_compute', 'callback_delivery',
] as const;
export type SourcingStage = typeof SOURCING_STAGES[number];
type Measurement = { calls:number; failures:number; totalMs:number; maxMs:number; firstStartMs:number; lastEndMs:number };
const boundedMs = (value:number) => Math.round(Math.max(0, Math.min(86_400_000, value)));

export class SourcingTimings {
  private readonly started:number;
  private readonly startedAt=new Date().toISOString();
  private readonly stages:Partial<Record<SourcingStage,Measurement>> = {};
  constructor(private readonly now:()=>number = () => performance.now()) { this.started=now(); }
  async measure<T>(stage:SourcingStage, operation:()=>Promise<T>):Promise<T> {
    const start=this.now(); let failed=false;
    try { return await operation(); }
    catch(error) { failed=true; throw error; }
    finally {
      const end=this.now(), elapsed=boundedMs(end-start);
      const previous=this.stages[stage];
      this.stages[stage]={calls:Math.min(100_000,(previous?.calls??0)+1),
        failures:Math.min(100_000,(previous?.failures??0)+(failed?1:0)),
        totalMs:boundedMs((previous?.totalMs??0)+elapsed),maxMs:Math.max(previous?.maxMs??0,elapsed),
        firstStartMs:Math.min(previous?.firstStartMs??Infinity,boundedMs(start-this.started)),
        lastEndMs:Math.max(previous?.lastEndMs??0,boundedMs(end-this.started))};
    }
  }
  snapshot() {
    return {version:1 as const, scope:'latest_worker_invocation' as const,
      startedAt:this.startedAt, elapsedMs:boundedMs(this.now()-this.started), stages:structuredClone(this.stages)};
  }
}
const context=new AsyncLocalStorage<SourcingTimings>();
export function withSourcingTimings<T>(operation:()=>Promise<T>):Promise<T> {
  return context.run(new SourcingTimings(),operation);
}
export function currentSourcingTimings() { return context.getStore()?.snapshot(); }
export function measureSourcingStage<T>(stage:SourcingStage, operation:()=>Promise<T>):Promise<T> {
  const recorder=context.getStore();
  return recorder ? recorder.measure(stage,operation) : operation();
}
export function timedSourcingFunction<A extends unknown[],R>(stage:SourcingStage, operation:(...args:A)=>Promise<R>):(...args:A)=>Promise<R> {
  return (...args)=>measureSourcingStage(stage,()=>operation(...args));
}
