import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for the request table: enough of findMany/updateMany to
// exercise the recovery's selection, ordering, claim and review rules.
type Row = Record<string, any>;
const rows: Row[] = [];
function matches(row: Row, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, cond]: [string, any]) => {
    if (key === "OR") return cond.some((c: any) => matches(row, c));
    const v = row[key];
    if (cond === null) return v === null;
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond && !cond.in.includes(v)) return false;
      if ("equals" in cond && v !== cond.equals) return false;
      if ("not" in cond && (cond.not === null ? v === null : v === cond.not)) return false;
      if ("gte" in cond && !(v >= cond.gte)) return false;
      if ("lt" in cond && !(v < cond.lt)) return false;
      if ("lte" in cond && !(v <= cond.lte)) return false;
      return true;
    }
    return v === cond;
  });
}
vi.mock("@/lib/prisma", () => ({
  prisma: {
    jobSourcingRequest: {
      findMany: async ({ where, orderBy, take }: any) =>
        rows.filter((r) => matches(r, where))
          .sort((a, b) => {
            for (const order of [orderBy].flat()) {
              const [key, dir] = Object.entries(order)[0] as [string, string];
              const d = (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (dir === "desc" ? -1 : 1);
              if (d) return d;
            }
            return 0;
          })
          .slice(0, take).map((r) => ({ ...r })),
      updateMany: async ({ where, data }: any) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
    },
  },
}));
vi.mock("../callback", () => ({ deliverCallback: vi.fn() }));

import {
  buildTerminalRecoveryWhere, parseRedeliveryNotBefore, recoveryBackoffMs,
  redeliverTerminalCallbacks, releaseCallbackReview,
} from "../callback-recovery";

const floor = new Date("2026-10-27T08:00:00.000Z");
let clock = new Date("2026-10-27T10:00:00.000Z");
const now = () => clock;
function request(id: string, over: Row = {}): Row {
  return {
    id, tenantId: "t1", externalJobId: `job-${id}`, callbackUrl: "https://flow.invalid/cb", status: "failed",
    flowRunId: "00000000-0000-4000-8000-000000000001", callbackStatus: "pending",
    completedAt: new Date("2026-10-27T09:00:00.000Z"), acquisitionGeneration: 1, executionAttemptId: `attempt-${id}`,
    processingLeaseId: `lease-${id}`, resultCount: 0, callbackRedeliveryAttempts: 0, callbackNextRedeliveryAt: null,
    callbackReviewRequiredAt: null, ...over,
  };
}
beforeEach(() => { rows.length = 0; clock = new Date("2026-10-27T10:00:00.000Z"); });

describe("terminal-callback recovery", () => {
  it("selects governed failed and complete searches since the floor, nothing else", async () => {
    rows.push(request("eligible"), request("complete", { status: "complete" }), request("ungoverned", { flowRunId: null }),
      request("ungoverned-complete", { status: "complete", flowRunId: null }),
      request("historical", { completedAt: new Date("2026-10-27T07:59:59.000Z") }),
      request("historical-complete", { status: "complete", completedAt: new Date("2026-10-27T07:59:59.000Z") }),
      request("delivered", { callbackStatus: "delivered" }), request("delivered-complete", { status: "complete", callbackStatus: "delivered" }),
      request("processing", { status: "processing" }), request("queued", { status: "queued" }),
      request("too-recent", { completedAt: new Date("2026-10-27T09:58:00.000Z") }));
    const sent: string[] = [];
    await redeliverTerminalCallbacks({ notBefore: floor, now, deliver: (async (id: string) => { sent.push(id); return true; }) as any });
    expect(sent.sort()).toEqual(["complete", "eligible"]);
    expect(buildTerminalRecoveryWhere(floor, clock)).toMatchObject({ status: { in: ["failed", "complete"] }, flowRunId: { not: null }, callbackReviewRequiredAt: null });
  });

  it("resends a complete search as complete with its own identity, fence and published count", async () => {
    rows.push(request("c1", { status: "complete", resultCount: 0 }), request("c2", { status: "complete", resultCount: 7 }));
    const deliver = vi.fn().mockResolvedValue(true);
    await redeliverTerminalCallbacks({ notBefore: floor, now, deliver: deliver as any });
    const byId = Object.fromEntries(deliver.mock.calls.map((c: any[]) => [c[0], c]));
    expect(byId.c1[3]).toMatchObject({ requestId: "c1", status: "complete", candidateCount: 0, acquisitionGeneration: 1, executionAttemptId: "attempt-c1" });
    expect(byId.c2[3]).toMatchObject({ status: "complete", candidateCount: 7 });
    expect(byId.c1[4]).toBe(true);
    expect(byId.c1[5]).toEqual({ acquisitionGeneration: 1, executionAttemptId: "attempt-c1", processingLeaseId: "lease-c1" });
  });

  it("both terminal statuses stop at the retry cap and go to review; an operator can release either", async () => {
    rows.push(request("f", { callbackRedeliveryAttempts: 11 }), request("c", { status: "complete", callbackRedeliveryAttempts: 11 }));
    const deliver = vi.fn().mockResolvedValue(false);
    const out = await redeliverTerminalCallbacks({ notBefore: floor, now, deliver: deliver as any });
    expect(out).toMatchObject({ attempted: 2, failed: 2, review: 2 });
    for (const id of ["f", "c"]) expect(rows.find(r => r.id === id)).toMatchObject({ callbackRedeliveryAttempts: 12, callbackStatus: "pending" });
    expect(rows.every(r => r.callbackReviewRequiredAt instanceof Date)).toBe(true);
    clock = new Date(clock.getTime() + 24 * 3600_000);
    expect(await redeliverTerminalCallbacks({ notBefore: floor, now, deliver: deliver as any })).toMatchObject({ attempted: 0 });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(await releaseCallbackReview({ requestId: "c", tenantId: "t1" })).toBe(true);
    expect(rows.find(r => r.id === "c")).toMatchObject({ callbackReviewRequiredAt: null, callbackRedeliveryAttempts: 0 });
  });

  it("resends the original execution identity and fence, as a failure", async () => {
    rows.push(request("r1"));
    const deliver = vi.fn().mockResolvedValue(true);
    await redeliverTerminalCallbacks({ notBefore: floor, now, deliver: deliver as any });
    expect(deliver).toHaveBeenCalledWith("r1", "t1", "https://flow.invalid/cb",
      expect.objectContaining({ requestId: "r1", status: "failed", acquisitionGeneration: 1, executionAttemptId: "attempt-r1" }), true,
      { acquisitionGeneration: 1, executionAttemptId: "attempt-r1", processingLeaseId: "lease-r1" });
  });

  it("backs off per request and does not retry before the next attempt is due", async () => {
    rows.push(request("r1"));
    const deliver = vi.fn().mockResolvedValue(false);
    await redeliverTerminalCallbacks({ notBefore: floor, now, deliver: deliver as any });
    expect(rows[0].callbackRedeliveryAttempts).toBe(1);
    expect(rows[0].callbackNextRedeliveryAt.getTime() - clock.getTime()).toBe(recoveryBackoffMs(1));
    await redeliverTerminalCallbacks({ notBefore: floor, now, deliver: deliver as any });
    expect(deliver).toHaveBeenCalledTimes(1);
    clock = new Date(clock.getTime() + recoveryBackoffMs(1));
    await redeliverTerminalCallbacks({ notBefore: floor, now, deliver: deliver as any });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect([1, 2, 3, 9, 10, 20].map(recoveryBackoffMs)).toEqual([60_000, 120_000, 240_000, 15_360_000, 21_600_000, 21_600_000]);
  });

  it("repeatedly failing callbacks cannot starve newer failures", async () => {
    for (let n = 0; n < 5; n++) rows.push(request(`poison-${n}`, { completedAt: new Date("2026-10-27T08:30:00.000Z"), callbackRedeliveryAttempts: 6 }));
    rows.push(request("new-failure"));
    const sent: string[] = [];
    await redeliverTerminalCallbacks({ notBefore: floor, now, limit: 2, deliver: (async (id: string) => { sent.push(id); return false; }) as any });
    expect(sent[0]).toBe("new-failure");
    expect(sent).toHaveLength(2);
  });

  it("flags an exhausted callback for review, keeps it pending, and an operator can release it", async () => {
    rows.push(request("r1", { callbackRedeliveryAttempts: 11 }));
    const result = await redeliverTerminalCallbacks({ notBefore: floor, now, maxAttempts: 12, deliver: (async () => false) as any });
    expect(result).toMatchObject({ attempted: 1, failed: 1, review: 1 });
    expect(rows[0]).toMatchObject({ callbackStatus: "pending", callbackReviewRequiredAt: clock, callbackNextRedeliveryAt: null });
    const later = vi.fn();
    await redeliverTerminalCallbacks({ notBefore: floor, now, deliver: later as any });
    expect(later).not.toHaveBeenCalled();
    expect(await releaseCallbackReview({ requestId: "r1", tenantId: "t1" })).toBe(true);
    expect(rows[0]).toMatchObject({ callbackRedeliveryAttempts: 0, callbackReviewRequiredAt: null });
    expect(await releaseCallbackReview({ requestId: "r1", tenantId: "t1" })).toBe(false);
  });

  it("stops once Flow acknowledges, and a lost acknowledgement is simply sent again", async () => {
    rows.push(request("r1"));
    // First attempt: Flow processed it but the response was lost.
    await redeliverTerminalCallbacks({ notBefore: floor, now, deliver: (async () => false) as any });
    clock = new Date(clock.getTime() + recoveryBackoffMs(1));
    const deliver = vi.fn(async () => { rows[0].callbackStatus = "delivered"; return true; });
    await redeliverTerminalCallbacks({ notBefore: floor, now, deliver: deliver as any });
    expect(deliver).toHaveBeenCalledTimes(1);
    clock = new Date(clock.getTime() + 24 * 60 * 60_000);
    await redeliverTerminalCallbacks({ notBefore: floor, now, deliver: deliver as any });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("a claimed attempt is not sent twice when two workers race", async () => {
    rows.push(request("r1"));
    const deliver = vi.fn().mockResolvedValue(false);
    await Promise.all([
      redeliverTerminalCallbacks({ notBefore: floor, now, deliver: deliver as any }),
      redeliverTerminalCallbacks({ notBefore: floor, now, deliver: deliver as any }),
    ]);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("accepts only a strict past UTC instant as the floor", () => {
    expect(parseRedeliveryNotBefore("2026-10-27T09:00:00Z", clock)?.toISOString()).toBe("2026-10-27T09:00:00.000Z");
    expect(parseRedeliveryNotBefore("2026-10-27T09:00:00.123Z", clock)).not.toBeNull();
    for (const bad of [undefined, "", "2026-10-27", "2026-10-27T09:00:00+05:30", "yesterday", "2026-10-27T11:00:00Z"])
      expect(parseRedeliveryNotBefore(bad as string | undefined, clock)).toBeNull();
  });
  it("never sends past the budget after a crash at the final claim; the row is settled for review", async () => {
    // State left by a crash after claiming attempt 12 and before flagging it.
    rows.push(request("r1", { callbackRedeliveryAttempts: 12, callbackNextRedeliveryAt: new Date(clock.getTime() + 6 * 3600_000) }));
    const deliver = vi.fn().mockResolvedValue(false);
    const result = await redeliverTerminalCallbacks({ notBefore: floor, now, maxAttempts: 12, deliver: deliver as any });
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toMatchObject({ attempted: 0, review: 1 });
    expect(rows[0]).toMatchObject({ callbackRedeliveryAttempts: 12, callbackStatus: "pending", callbackReviewRequiredAt: clock });
    // Repeated restarts never send attempt 13.
    for (let n = 0; n < 3; n++) await redeliverTerminalCallbacks({ notBefore: floor, now, maxAttempts: 12, deliver: deliver as any });
    expect(deliver).not.toHaveBeenCalled();
    expect(rows[0].callbackRedeliveryAttempts).toBe(12);
  });
  it("the final claim itself is fenced by the budget", async () => {
    rows.push(request("r1", { callbackRedeliveryAttempts: 11 }));
    const deliver = vi.fn(async () => { rows[0].callbackRedeliveryAttempts = 12; return false; });
    await redeliverTerminalCallbacks({ notBefore: floor, now, maxAttempts: 12, deliver: deliver as any });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(rows[0].callbackReviewRequiredAt).toEqual(clock);
  });
});
