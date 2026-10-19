/** Fixed metadata only: never log exception messages, SQL, profiles or provider replies. */
export type MemoryPreparationStage = 'enqueue_input' | 'read_existing' | 'packet_build' |
  'manifest' | 'privacy_context' | 'privacy_proofs' | 'transaction' | 'privacy_lock' |
  'privacy_recheck' | 'append' | 'seal' | 'readback';

const stages = new Set<MemoryPreparationStage>(['enqueue_input', 'read_existing', 'packet_build',
  'manifest', 'privacy_context', 'privacy_proofs', 'transaction', 'privacy_lock',
  'privacy_recheck', 'append', 'seal', 'readback']);
const tagged = new WeakMap<object, { stage: MemoryPreparationStage; elapsedMs: number }>();
const reasons: Record<string, string> = Object.freeze({
  memory_packet_integrity: 'packet_integrity', candidate_privacy_conflict: 'privacy_conflict',
  candidate_privacy_unavailable: 'privacy_unavailable', candidate_privacy_restricted: 'privacy_restricted',
  MEMORY_EXECUTION_STALE: 'execution_stale', MEMORY_PACKET_INVALID: 'packet_invalid',
  MEMORY_PACKET_CONFLICT: 'packet_conflict', MEMORY_MEMBERS_INCOMPLETE: 'members_incomplete',
  MEMORY_ACQUISITION_REFUSED: 'acquisition_refused',
  sourced_candidate_profile_field_too_large: 'profile_field_too_large',
  sourced_candidate_private_value_refused: 'private_value_refused',
  sourced_candidate_profile_list_invalid: 'profile_list_invalid',
  sourced_candidate_profile_missing: 'profile_missing',
  sourced_candidate_provider_id_invalid: 'provider_id_invalid',
  sourced_candidate_linkedin_invalid: 'linkedin_invalid',
  sourced_candidate_receipt_invalid: 'receipt_invalid',
  sourced_candidate_generation_invalid: 'generation_invalid',
  sourced_candidate_certification_invalid: 'certification_invalid',
  sourced_candidate_education_invalid: 'education_invalid',
  sourced_candidate_employment_invalid: 'employment_invalid',
  sourced_candidate_honor_invalid: 'honor_invalid',
});
const codes: Record<string, string> = Object.freeze({
  P2028: 'transaction_api_error', P2024: 'connection_pool_timeout', P2010: 'database_query_failed',
  P1001: 'database_unreachable', P1002: 'database_timeout', P1017: 'database_connection_closed',
  '42501': 'database_permission_denied', '57014': 'database_statement_cancelled',
  '55P03': 'database_lock_unavailable', '40001': 'database_serialization_failure',
  '40P01': 'database_deadlock',
});

export async function memoryPreparationStage<T>(stage: MemoryPreparationStage, work: () => T | Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await work(); } catch (error) {
    if (error !== null && typeof error === 'object' && !tagged.has(error)) {
      tagged.set(error, {stage, elapsedMs: Math.max(0, Math.round(performance.now() - start))});
    }
    throw error; // Preserve the exact error and all existing retry decisions.
  }
}

export function memoryPreparationFailure(error: unknown, fallback: MemoryPreparationStage = 'enqueue_input') {
  const e = error !== null && typeof error === 'object' ? error as {
    message?: unknown; code?: unknown; meta?: { code?: unknown };
  } : undefined;
  const tag = e ? tagged.get(e) : undefined;
  // Exact allowlists only. In particular P2028 is not proof of a timeout.
  const reason = typeof e?.message === 'string' && Object.hasOwn(reasons, e.message) ? reasons[e.message] :
    typeof e?.meta?.code === 'string' && Object.hasOwn(codes, e.meta.code) ? codes[e.meta.code] :
    typeof e?.code === 'string' && Object.hasOwn(codes, e.code) ? codes[e.code] : 'unexpected';
  return { stage: stages.has(tag?.stage ?? fallback) ? tag?.stage ?? fallback : 'enqueue_input',
    reason, ...(tag ? {elapsedMs: tag.elapsedMs} : {}) };
}
