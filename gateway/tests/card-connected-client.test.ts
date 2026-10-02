import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// =============================================================================
// notifyCardConnected (CA-F16c) — the card-connected call READS its answer.
//
// It was a bare fetch whose response nobody looked at: a drifted token's 403,
// a 5xx and a refused connection all converted nothing and said nothing. The
// cases assert HOW MANY TIMES the payment service was asked, because every
// branch resolves without throwing and a status-only check cannot tell "gave
// up at once" from "retried".
// =============================================================================

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { notifyCardConnected } from "../src/lib/card-connected-client.js";

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.PAYMENT_SERVICE_URL = "http://payment.test";
  process.env.INTERNAL_SERVICE_TOKEN = "tok";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function run(): Promise<boolean> {
  const p = notifyCardConnected("reader-1");
  await vi.runAllTimersAsync();
  return p;
}

describe("notifyCardConnected", () => {
  it("a 2xx is confirmed on the first call, and the body names only the reader", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    expect(await run()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://payment.test/api/v1/card-connected");
    expect(JSON.parse(init.body)).toEqual({ readerId: "reader-1" });
    expect(init.headers["x-internal-token"]).toBe("tok");
  });

  it("a 5xx is retried, and a later 2xx confirms", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    expect(await run()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a thrown fetch (refused, timeout) is retried up to the budget, then reported unconfirmed", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await run()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a 4xx is FINAL — a drifted token is not fixed by asking again", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    expect(await run()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
