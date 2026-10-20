import {describe,expect,it} from 'vitest';
import {memoryDeliveryFailure} from '../memory-delivery-diagnostics';

describe('safe Memory delivery failures',()=>{
 it.each([
  [{name:'TimeoutError'},'timeout'],[{name:'AbortError'},'aborted'],
  [{cause:{code:'ECONNRESET'}},'connection_reset'],
  [{cause:{code:'ENOTFOUND'}},'dns_unavailable'],
  [{code:'P2028'},'transaction_api_error'],
  [{code:'P2010',meta:{code:'40P01'}},'database_deadlock'],
  [{message:'candidate_privacy_unavailable'},'privacy_unavailable'],
  [{message:'private profile and key',code:'secret'},'unexpected'],
 ])('classifies only allowlisted metadata %#',(error,reason)=>{
  expect(memoryDeliveryFailure(error)).toBe(reason);
 });
});
