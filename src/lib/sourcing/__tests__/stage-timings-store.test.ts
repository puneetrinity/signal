import {describe,it,expect,vi} from 'vitest';
import type {PrismaClient} from '@prisma/client';
import {persistSourcingTimings,STAGE_TIMINGS_SQL} from '../stage-timings-store';
import {SourcingTimings} from '../stage-timings';

const identity={requestId:'request',tenantId:'tenant',generation:1,executionAttemptId:'attempt',processingLeaseId:'lease'};
describe('timings persistence boundary',()=>{
  it.each([0,1])('reports exactly one matched lease, result %s',async count=>{
    const execute=vi.fn().mockResolvedValue(count);
    const transaction=vi.fn(async(callback:(tx:unknown)=>Promise<number>,_options:unknown)=>callback({$executeRawUnsafe:execute}));
    const database={$transaction:transaction} as unknown as Pick<PrismaClient,'$transaction'>;
    const snapshot=new SourcingTimings().snapshot();
    expect(await persistSourcingTimings(database,identity,snapshot)).toBe(count===1);
    expect(transaction.mock.calls[0][1]).toEqual({maxWait:1000,timeout:2000});
    expect(execute.mock.calls).toEqual([
      ["SET LOCAL statement_timeout='1000ms'"],["SET LOCAL lock_timeout='250ms'"],
      [STAGE_TIMINGS_SQL,JSON.stringify(snapshot),'request','tenant',1,'attempt','lease']]);
  });
  it('does not retry a failed diagnostic write',async()=>{
    const error=Error('unavailable'),transaction=vi.fn().mockRejectedValue(error);
    await expect(persistSourcingTimings({$transaction:transaction} as unknown as PrismaClient,identity,new SourcingTimings().snapshot())).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
