import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExternalContactProviderClient,
  parseFullEnrichCompletion,
} from "../providers";

describe("contact provider boundaries", () => {
  beforeEach(() => {
    process.env.FULLENRICH_API_KEY = "fullenrich-key";
    process.env.ENRICHLAYER_API_KEY = "enrichlayer-key";
    process.env.SIGNAL_PUBLIC_BASE_URL = "https://signal.example.com";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FULLENRICH_API_KEY;
    delete process.env.ENRICHLAYER_API_KEY;
    delete process.env.SIGNAL_PUBLIC_BASE_URL;
  });

  it("sends a signed-webhook recovery identity with every FullEnrich start", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ enrichment_id: "fe-1" }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ExternalContactProviderClient();

    await expect(
      client.startFullEnrich({
        operationId: "operation-1",
        generation: 3,
        requestKey: "fullenrich:operation-1:3",
        candidate: {
          linkedinUrl: "https://www.linkedin.com/in/alice",
          nameHint: "Alice Example",
          companyHint: "Acme",
        },
      }),
    ).resolves.toEqual({
      kind: "started",
      providerRecordId: "fe-1",
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.webhook_url).toBe(
      "https://signal.example.com/api/webhooks/fullenrich",
    );
    expect(body.data[0].custom).toEqual({
      operation: JSON.stringify({
        operation_id: "operation-1",
        generation: 3,
      }),
    });
  });

  it("accepts only FullEnrich deliverable/high-probability/catch-all evidence", () => {
    const result = parseFullEnrichCompletion(
      {
        status: "FINISHED",
        data: [
          {
            contact_info: {
              personal_emails: [
                {
                  email: "verified@example.com",
                  status: "DELIVERABLE",
                },
                {
                  email: "probable@example.com",
                  status: "HIGH_PROBABILITY",
                },
                {
                  email: "catchall@example.com",
                  status: "CATCH_ALL",
                },
                {
                  email: "bad@example.com",
                  status: "INVALID",
                },
              ],
            },
          },
        ],
      },
      "fe-1",
      "2026-07-25T12:00:00.000Z",
    );

    expect(result.kind).toBe("found");
    if (result.kind !== "found") throw new Error("expected evidence");
    expect(result.evidence.map((item) => item.email)).toEqual([
      "verified@example.com",
      "probable@example.com",
      "catchall@example.com",
    ]);
    expect(result.evidence[0]?.status).toBe("verified");
  });

  it.each(["CREDITS_INSUFFICIENT", "RATE_LIMIT", "UNKNOWN"])(
    "treats FullEnrich terminal status %s as failed",
    (status) => {
      expect(parseFullEnrichCompletion({ status }, "fe-1")).toEqual({
        kind: "failed",
        code: "fullenrich_failed",
      });
    },
  );

  it.each([408, 425, 429])(
    "retries a transient FullEnrich poll HTTP %s without losing webhook recovery",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("retry", { status })),
      );
      const client = new ExternalContactProviderClient();

      await expect(
        client.pollFullEnrich({ providerRecordId: "fe-1" }),
      ).resolves.toEqual({
        kind: "pending",
        code: "fullenrich_poll_unavailable",
      });
    },
  );

  it("treats EnrichLayer 5xx as ambiguous and never as a clean miss", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("unavailable", {
            status: 503,
          }),
      ),
    );
    const client = new ExternalContactProviderClient();
    await expect(
      client.callEnrichLayer({
        requestKey: "enrichlayer:operation-1:1",
        candidate: {
          linkedinUrl: "https://www.linkedin.com/in/alice",
          nameHint: null,
          companyHint: null,
        },
      }),
    ).resolves.toEqual({
      kind: "ambiguous",
      code: "enrichlayer_ambiguous",
    });
  });

  it("caps the EnrichLayer provider page size", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ emails: [] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ExternalContactProviderClient();

    await client.callEnrichLayer({
      requestKey: "enrichlayer:operation-1:1",
      candidate: {
        linkedinUrl: "https://www.linkedin.com/in/alice",
        nameHint: null,
        companyHint: null,
      },
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("page_size")).toBe("10");
  });
});
