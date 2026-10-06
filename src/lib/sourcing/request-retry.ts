export interface SourcingRetryDecision {
  retryable: boolean;
  startsNewAcquisition: boolean;
}

/** Internal recovery only: a committed exact purchase can be reused while
 * every observed slot is complete. No receipt, started, uncertain or cancelled
 * receipts never authorize an automatic purchase retry. */
export function canResumeGovernedPurchase(attemptsMade:number,maxAttempts:number,
  receipts:ReadonlyArray<{slot:string;status:string}>):boolean {
  return Number.isSafeInteger(attemptsMade)&&attemptsMade>=0&&Number.isSafeInteger(maxAttempts)&&
    attemptsMade+1<Math.min(maxAttempts,3)&&
    receipts.some(r=>r.slot==='exact'&&r.status==='complete')&&receipts.every(r=>r.status==='complete');
}

export function decideSourcingRetry(input: {
  status: string;
  callbackStatus: string | null;
  refreshRequested: boolean;
  forceSourcingRequested: boolean;
  governed?: boolean;
}): SourcingRetryDecision {
  // Governed callback reconciliation has its own durable redelivery path.
  // Neither a failed run nor legacy force/refresh can acquire another batch.
  if(input.governed)return {retryable:false,startsNewAcquisition:false};
  const executionIsActive =
    input.status === "queued" ||
    input.status === "processing" ||
    (input.status === "complete" && input.callbackStatus === "pending");
  if (executionIsActive) {
    return { retryable: false, startsNewAcquisition: false };
  }

  // Signal keeps sourcing status `complete` when only callback delivery fails,
  // while Flow marks that downstream run failed. Both failure shapes must keep
  // their paid generation even when Flow sends its normal `forceSourcing`.
  // `refresh` is the explicit operator recovery for an uncertain receipt.
  const executionFailed =
    input.status === "failed" ||
    (input.status === "complete" && input.callbackStatus === "failed");
  const startsNewAcquisition =
    input.refreshRequested ||
    (!executionFailed && input.forceSourcingRequested);
  return {
    retryable: executionFailed || startsNewAcquisition,
    startsNewAcquisition,
  };
}
