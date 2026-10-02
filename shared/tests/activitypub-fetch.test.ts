import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createVerify, createPublicKey, generateKeyPairSync } from "node:crypto";

// =============================================================================
// The three arms of an ActivityPub read: unsigned → signed → (caller's) client API
//
// WHAT IS MOCKED AND WHY. Only the transport. Everything under test is about
// WHICH request is made after a refusal, and whether it was signed — so the
// mock answers from the URL and the options it is handed, records both, and
// calls `signRequest` exactly as the real client does. Asserting the CALL LIST
// rather than the return value is the point: "we fell back and it worked" and
// "we never fell back" produce the same successful result, and only the list
// tells them apart (the lesson from the `activitypub-secure-mode` suites, where
// a `null` return is what a fallback that RAN and failed gives too).
//
// The signature the second arm sends is verified against the published public
// key here as well, because a signed attempt that does not verify is
// indistinguishable at this layer from one that was never sent — both end in a
// 401 — and this is the only place the two can still be told apart.
//
// MUTATION CHECKS (each fails the named case):
//   never escalate to a signed attempt        → "escalates to a signed request"
//   escalate before checking apSigningConfigured → "does not sign when no key is configured"
//   keep the memo after a signed refusal      → "forgets a host whose signature it refused"
//   memoise on any failure, not just 401/403  → "a 404 is a fact about the source"
// =============================================================================

const KEY_ENV = "AP_INSTANCE_PRIVATE_KEY_B64";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY_B64 = Buffer.from(
  privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  "utf8",
).toString("base64");

interface Attempt {
  url: string;
  headers: Record<string, string>;
  signed: boolean;
}

const attempts: Attempt[] = [];
/** url → the statuses to answer, in order. */
const script = new Map<string, number[]>();

vi.mock("../src/lib/http-client.js", () => ({
  safeFetch: vi.fn(
    async (
      url: string,
      options: {
        headers?: Record<string, string>;
        signRequest?: (r: { method: string; url: string }) => Record<
          string,
          string
        > | null;
      } = {},
    ) => {
      // The real client calls the hook per hop, after the hop's URL is
      // settled, and overlays what it returns. Mirrored here so a "was this
      // signed" assertion reads the same bytes a remote instance would.
      const signed = options.signRequest?.({ method: "GET", url }) ?? null;
      const headers = { ...(options.headers ?? {}), ...(signed ?? {}) };
      attempts.push({ url, headers, signed: signed !== null });
      const queue = script.get(url);
      if (!queue || queue.length === 0)
        throw new Error(`unexpected fetch: ${url}`);
      const status = queue.length > 1 ? queue.shift()! : queue[0];
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        text: "{}",
        url,
      };
    },
  ),
}));

vi.mock("../src/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { AP_ACCEPT, fetchApDocument, resetSignedFetchMemo } = await import(
  "../src/lib/activitypub-fetch.js"
);
const { instanceActorPublicKeyPem, resetApSigningKeyCache } = await import(
  "../src/lib/http-signature.js"
);

const ACTOR = "https://secure.example/users/alice";
const OTHER = "https://open.example/users/bob";

const savedKey = process.env[KEY_ENV];
const savedApp = process.env.APP_URL;

beforeEach(() => {
  attempts.length = 0;
  script.clear();
  resetSignedFetchMemo();
  resetApSigningKeyCache();
  process.env.APP_URL = "https://all.haus";
  delete process.env[KEY_ENV];
});

afterEach(() => {
  if (savedKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = savedKey;
  if (savedApp === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedApp;
  resetApSigningKeyCache();
  resetSignedFetchMemo();
});

function withKey() {
  process.env[KEY_ENV] = KEY_B64;
  resetApSigningKeyCache();
}

/** Verify a recorded attempt's Signature the way the receiving instance does. */
function signatureVerifies(a: Attempt): boolean {
  const sig = Object.fromEntries(
    [...a.headers.Signature.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
  const parsed = new URL(a.url);
  const signingString = sig.headers
    .split(" ")
    .map((name) =>
      name === "(request-target)"
        ? `(request-target): get ${parsed.pathname}${parsed.search}`
        : name === "host"
          ? `host: ${parsed.host}`
          : `date: ${a.headers.Date}`,
    )
    .join("\n");
  return createVerify("RSA-SHA256")
    .update(signingString)
    .verify(createPublicKey(instanceActorPublicKeyPem()!), sig.signature, "base64");
}

describe("arm 1 — an ordinary instance", () => {
  it("reads unsigned and stops there", async () => {
    withKey();
    script.set(ACTOR, [200]);
    const out = await fetchApDocument(ACTOR);
    expect(out.res.ok).toBe(true);
    expect(out.signed).toBe(false);
    expect(out.signedFetchRefused).toBe(false);
    // The control for every case below: ONE attempt, and it carried no
    // signature. A reader that signed everything would pass a test that only
    // looked at the result.
    expect(attempts).toHaveLength(1);
    expect(attempts[0].signed).toBe(false);
    expect(attempts[0].headers.Accept).toBe(AP_ACCEPT);
  });

  it("a 404 is a fact about the source: no escalation, no refusal verdict", async () => {
    withKey();
    script.set(ACTOR, [404]);
    const out = await fetchApDocument(ACTOR);
    expect(out.signedFetchRefused).toBe(false);
    expect(attempts).toHaveLength(1);

    // And it did not memoise: the next read still starts unsigned. A memo set
    // on any failure would quietly turn every flaky instance into a signed-only
    // one, which is how a domain block would start applying to hosts that never
    // asked for a signature.
    script.set(ACTOR, [200]);
    await fetchApDocument(ACTOR);
    expect(attempts[1].signed).toBe(false);
  });
});

describe("arm 2 — a secure-mode instance", () => {
  it("escalates to a signed request, and the signature verifies", async () => {
    withKey();
    script.set(ACTOR, [401, 200]);
    const out = await fetchApDocument(ACTOR);

    expect(attempts.map((a) => a.signed)).toEqual([false, true]);
    expect(attempts[1].url).toBe(ACTOR);
    expect(signatureVerifies(attempts[1])).toBe(true);
    expect(out.res.ok).toBe(true);
    expect(out.signed).toBe(true);
    expect(out.signedFetchRefused).toBe(false);
  });

  it("403 escalates as well as 401", async () => {
    withKey();
    script.set(ACTOR, [403, 200]);
    await fetchApDocument(ACTOR);
    expect(attempts.map((a) => a.signed)).toEqual([false, true]);
  });

  it("remembers the host, so the next read signs first", async () => {
    withKey();
    script.set(ACTOR, [401, 200]);
    await fetchApDocument(ACTOR);
    attempts.length = 0;

    script.set(ACTOR, [200]);
    const out = await fetchApDocument(ACTOR);
    // ONE attempt, signed. Without the memo every poll of every secure-mode
    // source pays a wasted 401 for ever.
    expect(attempts).toHaveLength(1);
    expect(attempts[0].signed).toBe(true);
    expect(out.signed).toBe(true);
  });

  it("the memo is per host, and does not spread", async () => {
    withKey();
    script.set(ACTOR, [401, 200]);
    await fetchApDocument(ACTOR);
    attempts.length = 0;

    script.set(OTHER, [200]);
    await fetchApDocument(OTHER);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].signed).toBe(false);
  });
});

describe("arm 2 refused — the verdict the caller acts on", () => {
  it("reports signedFetchRefused when even a signature is refused", async () => {
    withKey();
    script.set(ACTOR, [401, 401]);
    const out = await fetchApDocument(ACTOR);
    expect(attempts.map((a) => a.signed)).toEqual([false, true]);
    // This is what stops the ingest task spending the source's error budget,
    // and what makes the admin count possible. It must be TRUE here and FALSE
    // in every case above.
    expect(out.signedFetchRefused).toBe(true);
  });

  it("forgets a host whose signature it refused", async () => {
    // An instance that has turned secure mode off again would otherwise stay
    // signed-only for as long as the process lives — and if the reason was a
    // domain block on our signing actor, signed-only is exactly the posture
    // that keeps us locked out of reads it would still serve unsigned.
    withKey();
    script.set(ACTOR, [401, 401]);
    await fetchApDocument(ACTOR);
    attempts.length = 0;

    script.set(ACTOR, [200]);
    await fetchApDocument(ACTOR);
    expect(attempts[0].signed).toBe(false);
  });
});

describe("with no key configured — exactly yesterday's behaviour", () => {
  it("does not sign when no key is configured, and still reports the refusal", async () => {
    script.set(ACTOR, [401]);
    const out = await fetchApDocument(ACTOR);
    // One attempt, unsigned. A second, signature-less attempt would double
    // every secure-mode instance's load for nothing.
    expect(attempts).toHaveLength(1);
    expect(attempts[0].signed).toBe(false);
    // The verdict survives: the client-API fallback is still the caller's next
    // move, and the ingest task still must not spend the error budget.
    expect(out.signedFetchRefused).toBe(true);
    expect(out.signed).toBe(false);
  });

  it("a key that is set and malformed THROWS rather than reading as absent", async () => {
    process.env[KEY_ENV] = "not-base64-at-all!!";
    resetApSigningKeyCache();
    script.set(ACTOR, [401]);
    await expect(fetchApDocument(ACTOR)).rejects.toThrow(
      /AP_INSTANCE_PRIVATE_KEY_B64/,
    );
  });
});
