import { memoryPreparationFailure } from './memory-preparation-diagnostics';

/** Never include arbitrary exception text, URLs, SQL or provider bodies. */
export function memoryDeliveryFailure(error: unknown): string {
  const e = error && typeof error === 'object' ? error as {name?: unknown; code?: unknown; cause?: {code?: unknown}} : undefined;
  if (e?.name === 'TimeoutError') return 'timeout';
  if (e?.name === 'AbortError') return 'aborted';
  const code = e?.cause?.code ?? e?.code;
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'ECONNRESET') return 'connection_reset';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_unavailable';
  return memoryPreparationFailure(error).reason;
}
