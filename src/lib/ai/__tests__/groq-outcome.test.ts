import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({generate:vi.fn(),model:vi.fn(),getCache:vi.fn(),setCache:vi.fn(),get:vi.fn(),incr:vi.fn(),expire:vi.fn(),setex:vi.fn(),warn:vi.fn(),info:vi.fn(),error:vi.fn()}));
vi.mock('ai',()=>({generateObject:m.generate}));
vi.mock('@/lib/ai/groq',()=>({createGroqModel:m.model}));
vi.mock('@/lib/redis/cache',()=>({getCache:m.getCache,setCache:m.setCache}));
vi.mock('@/lib/redis/client',()=>({default:{get:m.get,incr:m.incr,expire:m.expire,setex:m.setex}}));
vi.mock('@/lib/logger',()=>({createLogger:()=>({warn:m.warn,info:m.info,error:m.error})}));
import {GroqFailure,groqFailure,groqFailureFields} from '../groq-outcome';
import {groqClassifyRole} from '@/lib/taxonomy/role-groq';
import {groqClassifyLocation} from '@/lib/taxonomy/location-groq';
import {groqClassifyTrack} from '@/lib/sourcing/track-groq';
import {groqParser} from '@/lib/search/parsers/groq';
import {resolveRole,resolveRoleDeterministic} from '@/lib/taxonomy/role-service';
import type {SourcingConfig} from '@/lib/sourcing/config';
const config={roleGroqEnabled:true,roleGroqTimeoutMs:10,roleGroqMaxRetries:1,roleGroqCacheTtlDays:1,roleCbWindowSec:60,roleCbThreshold:5,roleCbCooldownSec:60,
 locationGroqEnabled:true,locationGroqTimeoutMs:10,locationGroqMaxRetries:1,locationGroqCacheTtlDays:1,locationCbWindowSec:60,locationCbThreshold:5,locationCbCooldownSec:60,
 trackGroqTimeoutMs:10,trackGroqMaxRetries:1,trackGroqCacheTtlDays:1,trackClassifierVersion:'test',trackCbWindowSec:60,trackCbThreshold:5,trackCbCooldownSec:60} as SourcingConfig;
vi.mock('@/lib/sourcing/config',()=>({getSourcingConfig:()=>config}));
const role=()=>groqClassifyRole('PRIVATE_TITLE','PRIVATE_CONTEXT',config);
const location=()=>groqClassifyLocation('PRIVATE_LOCATION','PRIVATE_CONTEXT',config);
const track=()=>groqClassifyTrack({title:'PRIVATE_TITLE',jdDigest:'PRIVATE_JD'},config);
const parser=()=>groqParser.parseSearchQuery('PRIVATE_QUERY');
beforeEach(()=>{
 vi.resetAllMocks();vi.useFakeTimers();vi.stubEnv('GROQ_API_KEY','PRIVATE_KEY');
 vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected network request');}));
 m.model.mockResolvedValue({model:{},modelName:'test-model'});m.getCache.mockResolvedValue(null);m.get.mockResolvedValue(null);m.incr.mockResolvedValue(1);m.setCache.mockResolvedValue(true);
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('safe Groq failure reasons',()=>{
 it.each([
  [{statusCode:401},'authentication'],[{statusCode:403},'authentication'],[{statusCode:404},'model_unavailable'],
  [{statusCode:429},'rate_limited'],[{statusCode:503},'provider_unavailable'],[{name:'TimeoutError'},'timeout'],
  [{name:'AI_NoObjectGeneratedError'},'invalid_response'],[{name:'AI_TypeValidationError'},'invalid_response'],
  [new SyntaxError('private body'),'invalid_response'],[new Error('ECONNRESET private URL'),'network'],[{},'unexpected'],
 ])('classifies without copying provider content %#',(error,reason)=>{
  expect(groqFailureFields(groqFailure(Object.assign(error,{body:'PRIVATE_BODY',headers:{authorization:'PRIVATE_KEY'}}),2)))
   .toEqual({outcome:'failed',reason,attempts:2});
  expect(groqFailure(error).reason).toBe(reason);
 });
 it.each([['role',role],['location',location],['track',track],['parser',parser]] as const)('%s failures are not valid empty answers',async(_name,run)=>{
  m.generate.mockRejectedValue(Object.assign(new Error('PRIVATE_RESPONSE'),{statusCode:404,responseBody:'PRIVATE_BODY'}));
  await expect(run()).rejects.toMatchObject({name:'GroqFailure',reason:'model_unavailable'});
  expect(m.setCache).not.toHaveBeenCalled();
  const logs=JSON.stringify([m.warn.mock.calls,m.error.mock.calls]);
  for(const privateText of ['PRIVATE_TITLE','PRIVATE_CONTEXT','PRIVATE_LOCATION','PRIVATE_JD','PRIVATE_QUERY','PRIVATE_KEY','PRIVATE_RESPONSE','PRIVATE_BODY'])expect(logs).not.toContain(privateText);
 });
 it.each([['role',role],['location',location]] as const)('%s distinguishes missing config, open breaker and factory failure',async(_name,run)=>{
  vi.stubEnv('GROQ_API_KEY','');await expect(run()).rejects.toMatchObject({reason:'not_configured',attempts:0});expect(m.generate).not.toHaveBeenCalled();
  vi.stubEnv('GROQ_API_KEY','PRIVATE_KEY');m.get.mockResolvedValue(String(Date.now()+60000));
  await expect(run()).rejects.toMatchObject({reason:'circuit_open',attempts:0});expect(m.generate).not.toHaveBeenCalled();
  m.get.mockResolvedValue(null);m.model.mockRejectedValue(new Error('PRIVATE_FACTORY'));
  await expect(run()).rejects.toMatchObject({reason:'unexpected',attempts:0});
 });
 it('accepts a valid unknown role and null location fields; caches answers, not failures',async()=>{
  m.generate.mockImplementationOnce(async({schema})=>({object:schema.parse({family:'unknown',confidence:0.1})}));
  await expect(role()).resolves.toMatchObject({family:'',fallbackKind:'unknown',confidence:0.1});
  m.generate.mockImplementationOnce(async({schema})=>({object:schema.parse({city:null,countryCode:null,fallbackKind:'unknown',confidence:0.1})}));
  await expect(location()).resolves.toMatchObject({city:null,countryCode:null,fallbackKind:'unknown'});
  expect(m.setCache).toHaveBeenCalled();
 });
 it('keeps successful cache hits and makes no provider attempt',async()=>{
  m.getCache.mockResolvedValue({family:'backend',confidence:0.8,cached:false});
  await expect(role()).resolves.toMatchObject({family:'backend',cached:true});expect(m.generate).not.toHaveBeenCalled();
 });
 it('keeps role/location retry counts and reports a real timeout separately',async()=>{
  m.generate.mockImplementation(()=>new Promise(()=>{}));
  const pending=expect(role()).rejects.toMatchObject({reason:'timeout',attempts:2});
  await vi.advanceTimersByTimeAsync(25);await pending;expect(m.generate).toHaveBeenCalledTimes(2);
 });
 it('validation fails without role retry, while network failures retain the existing retry',async()=>{
  m.generate.mockRejectedValue(Object.assign(new Error('PRIVATE'),{name:'AI_TypeValidationError'}));
  await expect(role()).rejects.toMatchObject({reason:'invalid_response',attempts:1});expect(m.generate).toHaveBeenCalledTimes(1);
  m.generate.mockClear().mockRejectedValue(new Error('network unavailable'));
  await expect(location()).rejects.toMatchObject({reason:'network',attempts:2});expect(m.generate).toHaveBeenCalledTimes(2);
 });
 it('role service keeps its deterministic fallback but logs the failure explicitly',async()=>{
  m.generate.mockRejectedValue({statusCode:404});
  expect(await resolveRole('PRIVATE_TITLE')).toEqual(resolveRoleDeterministic('PRIVATE_TITLE'));
  expect(m.warn).toHaveBeenCalledWith({outcome:'failed',reason:'model_unavailable',attempts:1},'Role Groq fallback failed, using deterministic');
 });
 it('does not retain raw cause on a typed failure',()=>{
  const error=groqFailure({statusCode:503,body:'PRIVATE_BODY',message:'PRIVATE_KEY'},1);
  expect(error).toBeInstanceOf(GroqFailure);expect(JSON.stringify(error)).not.toContain('PRIVATE');expect(error.cause).toBeUndefined();
 });
});
