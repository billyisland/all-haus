import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// =============================================================================
// Email health (CONSOLIDATED-TODO §0r.3).
//
// The incident: a rejected Postmark server token made EVERY outbound email fail
// for up to 17 days, with no symptom on any surface — the login route catches
// the send error and answers 200 by design. What is pinned here is the set of
// ways this checker could report that state as fine, because each of them is a
// green suite over a broken platform:
//
//   • an ambiguous answer overwriting a proven one (a Postmark outage would
//     erase a proven rejection, or a blip would flap the banner),
//   • a provider with no probe reporting `valid` rather than "nothing checked",
//   • zero failures over zero sends reading as a healthy send path,
//   • a real send's own 401 being thrown away instead of believed.
//
// `safeFetch` is mocked, so nothing here touches the network.
// =============================================================================

const safeFetch = vi.fn();
vi.mock("../src/lib/http-client.js", () => ({
  safeFetch: (...args: unknown[]) => safeFetch(...args),
}));

const {
  classifyPostmarkProbeStatus,
  probeEmailCredential,
  notePostmarkResponse,
  trackSend,
  getEmailHealth,
  startEmailHealthChecks,
  __resetEmailHealth,
} = await import("../src/lib/email-health.js");

const okResponse = (status: number, text = "") => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  text,
  url: "https://api.postmarkapp.com/server",
});

const savedEnv = { ...process.env };

beforeEach(() => {
  safeFetch.mockReset();
  __resetEmailHealth();
  process.env.EMAIL_PROVIDER = "postmark";
  process.env.POSTMARK_API_KEY = "server-token";
});

afterEach(() => {
  __resetEmailHealth();
  process.env = { ...savedEnv };
});

describe("classifyPostmarkProbeStatus", () => {
  it("treats 2xx as proof the token is good", () => {
    expect(classifyPostmarkProbeStatus(200)).toBe("valid");
  });

  // 401 is the incident's own status (ErrorCode 10). 403 is included for the
  // reason the parity classifier includes both: writing the classifier for the
  // one status an incident happened to produce passes every test anyone thinks
  // to write and still never fires on the other.
  it("treats 401 and 403 as a definitive rejection", () => {
    expect(classifyPostmarkProbeStatus(401)).toBe("invalid");
    expect(classifyPostmarkProbeStatus(403)).toBe("invalid");
  });

  // The half that matters: an indefinite answer must NOT be a rejection, or a
  // vendor outage or an API move raises a credential alarm about a good token.
  it("treats everything indefinite as unreachable, never as a rejection", () => {
    for (const status of [404, 422, 429, 500, 502, 503]) {
      expect(classifyPostmarkProbeStatus(status)).toBe("unreachable");
    }
  });
});

describe("probeEmailCredential", () => {
  it("proves the credential on a 200 and records when", async () => {
    safeFetch.mockResolvedValue(okResponse(200, '{"Name":"all.haus"}'));
    expect(await probeEmailCredential()).toBe("valid");
    const report = getEmailHealth();
    expect(report.credential).toBe("valid");
    expect(report.credentialCheckedAt).not.toBeNull();
  });

  it("disproves it on a 401 and carries Postmark's own message through", async () => {
    safeFetch.mockResolvedValue(
      okResponse(401, '{"ErrorCode":10,"Message":"Request does not contain a valid Server token."}'),
    );
    expect(await probeEmailCredential()).toBe("invalid");
    const report = getEmailHealth();
    expect(report.credential).toBe("invalid");
    // ErrorCode 10 covers a wrong token AND an Account token pasted where a
    // Server token belongs — different fixes, so the operator gets the vendor's
    // wording rather than ours.
    expect(report.credentialDetail).toContain("ErrorCode 10");
    expect(report.credentialDetail).toContain("valid Server token");
  });

  // STICKY BOTH WAYS. Without this, one unanswered probe during a Postmark
  // outage erases a proven rejection and the banner goes green with the
  // platform still unable to send a single email.
  it("does not let an unreachable probe erase a proven rejection", async () => {
    safeFetch.mockResolvedValueOnce(okResponse(401, ""));
    await probeEmailCredential();
    expect(getEmailHealth().credential).toBe("invalid");

    safeFetch.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND"));
    expect(await probeEmailCredential()).toBe("unreachable");
    expect(getEmailHealth().credential).toBe("invalid");
  });

  it("does not let an unreachable probe erase a proven match either", async () => {
    safeFetch.mockResolvedValueOnce(okResponse(200, ""));
    await probeEmailCredential();
    safeFetch.mockResolvedValueOnce(okResponse(503, "upstream"));
    expect(await probeEmailCredential()).toBe("unreachable");
    expect(getEmailHealth().credential).toBe("valid");
  });

  // A missing key is definitive and needs no network: sendViaPostmark throws
  // before it fetches, so every send is already failing.
  it("calls a missing API key a rejection without asking Postmark", async () => {
    delete process.env.POSTMARK_API_KEY;
    expect(await probeEmailCredential()).toBe("invalid");
    expect(safeFetch).not.toHaveBeenCalled();
    expect(getEmailHealth().credentialDetail).toContain("POSTMARK_API_KEY");
  });

  // The all-clear this must never give. Resend's only credential endpoint
  // rejects a correctly-scoped send-only key, so probing it would raise a false
  // alarm; the answer is to report that nothing was checked, NOT to report OK.
  it("reports an unprobeable provider as unchecked, never as valid", async () => {
    process.env.EMAIL_PROVIDER = "resend";
    expect(await probeEmailCredential()).toBe("not_probeable");
    const report = getEmailHealth();
    expect(report.credential).toBeNull();
    expect(report.probeSupported).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("sends the token as the Postmark server-token header", async () => {
    safeFetch.mockResolvedValue(okResponse(200, ""));
    await probeEmailCredential();
    const [url, opts] = safeFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://api.postmarkapp.com/server");
    expect(opts.headers["X-Postmark-Server-Token"]).toBe("server-token");
  });
});

describe("notePostmarkResponse — the send is itself a probe", () => {
  // This is what would have caught the incident on its FIRST magic link rather
  // than at the next probe tick.
  it("a rejected real send disproves the credential immediately", () => {
    expect(getEmailHealth().credential).toBeNull();
    notePostmarkResponse(401, '{"ErrorCode":10,"Message":"Request does not contain a valid Server token."}');
    expect(getEmailHealth().credential).toBe("invalid");
  });

  it("a successful real send proves it", () => {
    notePostmarkResponse(200);
    expect(getEmailHealth().credential).toBe("valid");
  });

  // A rate limit is a real send failure — the counter carries it — and says
  // nothing whatever about the token. Recording it as evidence would clear a
  // proven rejection on a 429.
  it("an ambiguous status changes nothing about the credential", () => {
    notePostmarkResponse(401, "");
    notePostmarkResponse(429, "rate limited");
    expect(getEmailHealth().credential).toBe("invalid");
  });
});

describe("trackSend", () => {
  it("counts an attempt and returns the value", async () => {
    await trackSend(async () => "sent");
    const report = getEmailHealth();
    expect(report.attempted).toBe(1);
    expect(report.failed).toBe(0);
  });

  // Rethrowing is load-bearing: several callers catch a send failure on purpose
  // (the login route answers 200 either way). Swallowing it here would change
  // behaviour rather than observe it.
  it("counts a failure, keeps its message, and rethrows", async () => {
    await expect(
      trackSend(async () => {
        throw new Error("Postmark API error: 401");
      }),
    ).rejects.toThrow("Postmark API error: 401");

    const report = getEmailHealth();
    expect(report.attempted).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.lastError).toBe("Postmark API error: 401");
    expect(report.lastFailureAt).not.toBeNull();
  });

  // The empty denominator. A surface that shows only `failed` reads a platform
  // that has sent nothing at all as a platform whose email is working —
  // precisely the state the incident was in every quiet hour.
  it("reports zero sends as zero ATTEMPTS, not as zero failures", () => {
    const report = getEmailHealth();
    expect(report.attempted).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.sinceBootAt).not.toBeNull();
  });
});

describe("startEmailHealthChecks", () => {
  it("retries an unreachable probe at boot, then leaves it UNCONFIRMED", async () => {
    safeFetch.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const slept: number[] = [];
    await startEmailHealthChecks(async (ms) => {
      slept.push(ms);
    });
    // Four attempts across the three-step ladder, and the verdict is the third
    // state — never confirmed — not a rejection and not an all-clear.
    expect(safeFetch).toHaveBeenCalledTimes(4);
    expect(slept).toEqual([3_000, 15_000, 60_000]);
    expect(getEmailHealth().credential).toBeNull();
  });

  it("stops retrying as soon as it has a definitive answer", async () => {
    safeFetch.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    safeFetch.mockResolvedValueOnce(okResponse(200, ""));
    const slept: number[] = [];
    await startEmailHealthChecks(async (ms) => {
      slept.push(ms);
    });
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([3_000]);
    expect(getEmailHealth().credential).toBe("valid");
  });

  it("probes nothing when the provider is console, and claims nothing", async () => {
    process.env.EMAIL_PROVIDER = "console";
    await startEmailHealthChecks(async () => {});
    expect(safeFetch).not.toHaveBeenCalled();
    const report = getEmailHealth();
    expect(report.provider).toBe("console");
    expect(report.probeSupported).toBe(false);
    expect(report.credential).toBeNull();
  });
});
