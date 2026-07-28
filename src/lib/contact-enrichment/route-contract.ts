import type { ContactOperationSnapshot } from "./types";

export interface ContactRouteResult {
  status: number;
  body: {
    success: boolean;
    state:
      | "pending"
      | "provider_recovery_pending"
      | "found"
      | "suppressed"
      | "not_found"
      | "ambiguous"
      | "failed";
    emails: string[];
    code?: string;
  };
}

export function contactOperationRouteResult(
  operation: ContactOperationSnapshot,
): ContactRouteResult {
  if (operation.state === "found" && operation.selectedEmail) {
    return {
      status: 200,
      body: {
        success: true,
        state: "found",
        emails: [operation.selectedEmail],
      },
    };
  }
  if (operation.state === "found") {
    return {
      status: 409,
      body: {
        success: false,
        state: "failed",
        emails: [],
        code: "contact_result_missing",
      },
    };
  }
  if (operation.state === "suppressed") {
    return {
      status: 200,
      body: {
        success: true,
        state: "suppressed",
        emails: [],
      },
    };
  }
  if (operation.state === "not_found") {
    return {
      status: 200,
      body: {
        success: true,
        state: "not_found",
        emails: [],
      },
    };
  }
  if (operation.state === "fullenrich_ambiguous") {
    return {
      status: 202,
      body: {
        success: true,
        state: "provider_recovery_pending",
        emails: [],
        code: operation.lastErrorCode || "fullenrich_webhook_recovery_pending",
      },
    };
  }
  if (operation.state === "enrichlayer_ambiguous") {
    return {
      status: 409,
      body: {
        success: false,
        state: "ambiguous",
        emails: [],
        code: operation.lastErrorCode || "provider_result_ambiguous",
      },
    };
  }
  if (operation.state === "failed") {
    return {
      status: 409,
      body: {
        success: false,
        state: "failed",
        emails: [],
        code: operation.lastErrorCode || "contact_enrichment_failed",
      },
    };
  }
  return {
    status: 202,
    body: {
      success: true,
      state: "pending",
      emails: [],
    },
  };
}
