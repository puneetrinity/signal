/**
 * Scoring metadata versions for auditability.
 * Bump these when weight/logic semantics change.
 */

export const STATIC_SCORER_VERSION = 'v2.2-static';
export const DYNAMIC_SCORER_VERSION = 'v2.2-dynamic-shadow';

export type ScoringMode = 'static' | 'dynamic' | 'shadow';
