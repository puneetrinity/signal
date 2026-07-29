export interface SourcingRetryDecision {
  retryable: boolean;
  startsNewAcquisition: boolean;
}

export function decideSourcingRetry(input: {
  status: string;
  callbackStatus: string | null;
  refreshRequested: boolean;
  forceSourcingRequested: boolean;
}): SourcingRetryDecision {
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
