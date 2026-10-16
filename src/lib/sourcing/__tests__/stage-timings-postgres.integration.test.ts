import {describe,it,expect,beforeAll,afterAll} from 'vitest';
import {PrismaClient} from '@prisma/client';
import {persistSourcingTimings} from '../stage-timings-store';
import {SourcingTimings} from '../stage-timings';

// Dedicated, opt-in local fixture only. No reset or production URL fallback.
const dsn=process.env.STAGE_TIMINGS_TEST_DATABASE_URL;
const identity={requestId:'request',tenantId:'tenant',generation:1,executionAttemptId:'attempt',processingLeaseId:'lease'};
describe.skipIf(!dsn)('timings real PostgreSQL / restricted role',()=>{
  let owner:PrismaClient,runtime:PrismaClient;
  beforeAll(async()=>{
    const url=new URL(dsn!);
    if(url.pathname!=='/stage_timings_disposable'||!url.searchParams.get('host')?.startsWith('/tmp/codex-stage-timings-pg.'))throw Error('DISPOSABLE_DATABASE_REQUIRED');
    owner=new PrismaClient({datasources:{db:{url:dsn!}}});
    await owner.$executeRawUnsafe('CREATE ROLE stage_timing_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');
    await owner.$executeRawUnsafe(`CREATE TABLE public.job_sourcing_requests (
      id text PRIMARY KEY, "tenantId" text NOT NULL, acquisition_generation integer NOT NULL,
      execution_attempt_id text, processing_lease_id text, diagnostics jsonb)`);
    await owner.$executeRawUnsafe('GRANT SELECT ON public.job_sourcing_requests TO stage_timing_runtime');
    await owner.$executeRawUnsafe('GRANT UPDATE(diagnostics) ON public.job_sourcing_requests TO stage_timing_runtime');
    await owner.$executeRawUnsafe(`INSERT INTO public.job_sourcing_requests VALUES ('request','tenant',1,'attempt','lease','{"existing":{"keep":true}}')`);
    url.username='stage_timing_runtime';runtime=new PrismaClient({datasources:{db:{url:url.toString()}}});
  });
  afterAll(async()=>{await runtime?.$disconnect();await owner?.$disconnect();});
  const read=async()=> (await owner.$queryRawUnsafe<Array<{diagnostics:Record<string,unknown>}>>('SELECT diagnostics FROM public.job_sourcing_requests'))[0].diagnostics;
  it('merges one bounded record without losing other diagnostics, using only UPDATE(diagnostics)',async()=>{
    const snapshot=new SourcingTimings().snapshot();
    expect(await persistSourcingTimings(runtime,identity,snapshot)).toBe(true);
    expect(await read()).toEqual({existing:{keep:true},workerStageTimingV1:snapshot});
    await expect(runtime.$executeRawUnsafe("UPDATE public.job_sourcing_requests SET processing_lease_id='other'")).rejects.toThrow();
  });
  it.each(['requestId','tenantId','generation','executionAttemptId','processingLeaseId'] as const)('refuses a stale/wrong %s',async key=>{
    const before=await read();
    const wrong={...identity,[key]:key==='generation'?2:'wrong'};
    expect(await persistSourcingTimings(runtime,wrong,new SourcingTimings().snapshot())).toBe(false);
    expect(await read()).toEqual(before);
  });
  it('cannot write after the processing lease is released',async()=>{
    await owner.$executeRawUnsafe('UPDATE public.job_sourcing_requests SET processing_lease_id=NULL');
    expect(await persistSourcingTimings(runtime,identity,new SourcingTimings().snapshot())).toBe(false);
    await owner.$executeRawUnsafe("UPDATE public.job_sourcing_requests SET processing_lease_id='lease'");
  });
  it('times out on contention without changing the saved record',async()=>{
    let locked!:()=>void,release!:()=>void;
    const ready=new Promise<void>(resolve=>{locked=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const before=await read();
    const lock=owner.$transaction(async tx=>{await tx.$queryRawUnsafe('SELECT id FROM public.job_sourcing_requests FOR UPDATE');locked();await gate;});
    await ready;
    try { await expect(persistSourcingTimings(runtime,identity,new SourcingTimings().snapshot())).rejects.toThrow(); }
    finally { release();await lock; }
    expect(await read()).toEqual(before);
  });
});
