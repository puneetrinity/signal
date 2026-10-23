import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareMemoryPacket } from '../immutable-memory-ingest';
import { sendFrozenMemoryPacket } from '../activegraph-client';
import { CandidatePrivacyRestrictedError } from '@/lib/candidate-privacy/repository';
import type { CandidateForRanking } from '../ranking-new';

const mocks=vi.hoisted(()=>({privacy:vi.fn(),sign:vi.fn()}));
vi.mock('@/lib/candidate-privacy/decision',()=>({requireNewCandidateAllowed:mocks.privacy,createCandidateAdmissionProofs:vi.fn()}));
vi.mock('../activegraph-auth',()=>({signSourcedCandidateIngestJWT:mocks.sign,signActiveGraphJWT:vi.fn()}));
const owner={tenantId:'org_32',sourcingRequestId:'synthetic-request',acquisitionReceiptId:'synthetic-purchase',acquisitionGeneration:1,acquisitionSlot:'exact' as const};
const at=new Date('2026-10-19T00:00:00Z');
const packet=()=>prepareMemoryPacket(owner,{id:'https://linkedin.com/in/synthetic',searchSnippet:'Synthetic',
  crustdata:{crustdata_person_id:123,basic_profile:{name:'Synthetic'}}} as CandidateForRanking,{...owner,acquiredAt:at,profileObservedAt:at});
beforeEach(()=>{vi.useFakeTimers();mocks.privacy.mockReset().mockResolvedValue({});mocks.sign.mockReset().mockResolvedValue('synthetic-test-token');});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
describe('immutable transport (real serializer/transport, fake network only)',()=>{
 it('sends the exact stored bytes on every attempt, never a reserialized body',async()=>{
  const p=packet();const fetch=vi.fn().mockResolvedValue(new Response('',{status:409}));vi.stubGlobal('fetch',fetch);
  for(let i=0;i<3;i++)expect((await sendFrozenMemoryPacket(p,Date.now()+5000)).errorCode).toBe('http_409');
  expect(fetch).toHaveBeenCalledTimes(3);
  for(const [,init] of fetch.mock.calls){expect(init.body).toBe(p.requestBody);expect(init.redirect).toBe('error');}
  expect(mocks.privacy).toHaveBeenCalledTimes(3);
 });
 it('does not treat privacy unavailability as permanent suppression',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);mocks.privacy.mockRejectedValue(new Error('service unavailable'));
  expect((await sendFrozenMemoryPacket(packet(),Date.now()+5000)).errorCode).toBe('privacy_unavailable');
  expect(fetch).not.toHaveBeenCalled();expect(mocks.sign).not.toHaveBeenCalled();
 });
 it('suppresses a confirmed privacy restriction before token creation',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);mocks.privacy.mockRejectedValue(new CandidatePrivacyRestrictedError('candidate_privacy_restricted'));
  expect((await sendFrozenMemoryPacket(packet(),Date.now()+5000)).errorCode).toBe('privacy_restricted');
  expect(fetch).not.toHaveBeenCalled();expect(mocks.sign).not.toHaveBeenCalled();
 });
 it('does not dispatch when the shared deadline already expired',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect(sendFrozenMemoryPacket(packet(),Date.now())).rejects.toThrow('memory_wait_expired');
  expect(fetch).not.toHaveBeenCalled();expect(mocks.privacy).not.toHaveBeenCalled();
 });
 it('does not dispatch after privacy consumed the remaining time',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);mocks.privacy.mockImplementation(()=>new Promise(resolve=>setTimeout(resolve,100)));
  const attempt=sendFrozenMemoryPacket(packet(),Date.now()+50);await vi.advanceTimersByTimeAsync(101);await attempt;
  expect(fetch).not.toHaveBeenCalled();
 });
 it('starts the storage budget only after privacy allows the send',async()=>{
  // Privacy takes 4.5s; the old shared 5s timer would leave 0.5s for storage.
  mocks.privacy.mockImplementation(()=>new Promise(resolve=>setTimeout(resolve,4500)));
  let signal:AbortSignal|undefined;
  vi.stubGlobal('fetch',vi.fn(async(_url,init:RequestInit)=>{signal=init.signal!;
   await new Promise(resolve=>setTimeout(resolve,2000));return new Response('',{status:409});}));
  const attempt=sendFrozenMemoryPacket(packet(),Date.now()+30_000);
  await vi.advanceTimersByTimeAsync(4500+2000+1);
  expect((await attempt).errorCode).toBe('http_409');
  expect(signal?.aborted).toBe(false);
 });
 it('gives privacy its own bounded budget inside the overall deadline',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  const now=Date.now();
  expect((await sendFrozenMemoryPacket(packet(),now+30_000)).success).toBe(false);
  expect(mocks.privacy.mock.calls[0][2]).toBe(now+5000);
  mocks.privacy.mockClear();
  await sendFrozenMemoryPacket(packet(),now+1200);
  expect(mocks.privacy.mock.calls[0][2]).toBe(now+1200);
 });
 it('refuses disclosure when the privacy check times out',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  mocks.privacy.mockRejectedValue(new Error('candidate_privacy_unavailable'));
  expect((await sendFrozenMemoryPacket(packet(),Date.now()+30_000)).errorCode).toBe('privacy_unavailable');
  expect(fetch).not.toHaveBeenCalled();expect(mocks.sign).not.toHaveBeenCalled();
 });
 it('keeps the abort timer through slow response-body consumption',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(_url,init:RequestInit)=>new Response(new ReadableStream({
   start(controller){init.signal!.addEventListener('abort',()=>controller.error(new Error('aborted')),{once:true});}
  }))));
  const attempt=sendFrozenMemoryPacket(packet(),Date.now()+50);
  await vi.advanceTimersByTimeAsync(51);expect((await attempt).success).toBe(false);
 });
});
