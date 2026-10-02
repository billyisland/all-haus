import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createVerify,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import {
  apSigningConfigured,
  assertApSigningKeyUsable,
  instanceActorId,
  instanceActorKeyId,
  instanceActorPublicKeyPem,
  resetApSigningKeyCache,
  signedGetHeaders,
} from "../src/lib/http-signature.js";

// =============================================================================
// Outbound HTTP Signatures — the thing a remote instance actually does
//
// EVERY CASE HERE VERIFIES THE WAY MASTODON VERIFIES, rather than comparing
// our output to a second copy of our own code. A test that rebuilt the signing
// string with the same expression the signer uses would agree with itself
// about a typo in it, and the symptom on the far side — "your signature does
// not verify" — is exactly the same for a wrong signing string, a wrong key
// and a wrong keyId. So the assertions reconstruct the string from the
// SIGNATURE HEADER's own `headers=` list, as a verifier must, and check the
// bytes against the key the actor document publishes.
//
// MUTATION CHECKS (each run; each fails the case named):
//   drop `parsed.search` from the request target      → "signs the query string"
//   sign `host` as the hostname without the port      → "signs the port"
//   export the public key from a fresh keypair        → "the published key is the signing key"
//   return a cached Date instead of a per-request one → "mints a fresh date"
// =============================================================================

const KEY_ENV = "AP_INSTANCE_PRIVATE_KEY_B64";

function freshKeyB64(bits = 2048): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  return Buffer.from(
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    "utf8",
  ).toString("base64");
}

const KEY_B64 = freshKeyB64();

const savedKey = process.env[KEY_ENV];
const savedApp = process.env.APP_URL;

beforeEach(() => {
  process.env[KEY_ENV] = KEY_B64;
  process.env.APP_URL = "https://all.haus";
  resetApSigningKeyCache();
});

afterEach(() => {
  if (savedKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = savedKey;
  if (savedApp === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedApp;
  resetApSigningKeyCache();
});

/** Parse a Signature header into its comma-separated `k="v"` parameters. */
function parseSignature(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of header.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/**
 * Verify exactly as a receiving instance does: take the `headers=` list off the
 * Signature header, rebuild the signing string from the REQUEST (not from our
 * signer), and check it against the published public key.
 */
function verifyAsRemote(
  url: string,
  headers: Record<string, string>,
  publicKeyPem: string,
): boolean {
  const sig = parseSignature(headers.Signature);
  const parsed = new URL(url);
  const line = (name: string) => {
    if (name === "(request-target)")
      return `(request-target): get ${parsed.pathname}${parsed.search}`;
    if (name === "host") return `host: ${parsed.host}`;
    // Every other signed name is an ordinary header, read off the request the
    // way the receiver reads it — case-insensitively.
    const key = Object.keys(headers).find(
      (h) => h.toLowerCase() === name.toLowerCase(),
    );
    return `${name}: ${key ? headers[key] : ""}`;
  };
  const signingString = sig.headers.split(" ").map(line).join("\n");
  return createVerify("RSA-SHA256")
    .update(signingString)
    .verify(createPublicKey(publicKeyPem), sig.signature, "base64");
}

describe("the instance actor's identity", () => {
  it("derives the actor id and keyId from APP_URL", () => {
    expect(instanceActorId()).toBe("https://all.haus/actor");
    expect(instanceActorKeyId()).toBe("https://all.haus/actor#main-key");
  });

  it("has no identity without an APP_URL, and signs nothing", () => {
    // Not an error: a keyId that cannot be a URL is a signature nothing can
    // verify, and sending one is worse than sending none — several
    // implementations refuse a present-but-unverifiable signature where they
    // would have served an unsigned read.
    delete process.env.APP_URL;
    expect(instanceActorId()).toBeNull();
    expect(signedGetHeaders("https://secure.example/users/alice")).toBeNull();
  });
});

describe("the key", () => {
  it("is absent, not broken, when the variable is unset", () => {
    delete process.env[KEY_ENV];
    resetApSigningKeyCache();
    expect(apSigningConfigured()).toBe(false);
    expect(() => assertApSigningKeyUsable()).not.toThrow();
    expect(signedGetHeaders("https://secure.example/users/alice")).toBeNull();
  });

  it("THROWS at boot when it is set and malformed", () => {
    // The whole point of the boot check: a fallback is for an ABSENT value and
    // never for a malformed one. A typo that read as "signing is off" would
    // present as the fediverse refusing us — the symptom this work exists to
    // end, wearing the same clothes.
    for (const bad of ["not base64 at all!!", Buffer.from("hello").toString("base64")]) {
      process.env[KEY_ENV] = bad;
      resetApSigningKeyCache();
      expect(apSigningConfigured()).toBe(true);
      expect(() => assertApSigningKeyUsable()).toThrow(/AP_INSTANCE_PRIVATE_KEY_B64/);
    }
  });

  it("refuses a key below 2048 bits, which every verifier would refuse too", () => {
    process.env[KEY_ENV] = freshKeyB64(1024);
    resetApSigningKeyCache();
    expect(() => assertApSigningKeyUsable()).toThrow(/at least 2048 bits/);
  });

  it("refuses a key that is not RSA", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    process.env[KEY_ENV] = Buffer.from(
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      "utf8",
    ).toString("base64");
    resetApSigningKeyCache();
    expect(() => assertApSigningKeyUsable()).toThrow(/must be an RSA key/);
  });
});

describe("the signature a remote instance receives", () => {
  const URL_WITH_QUERY =
    "https://secure.example:8443/users/alice/outbox?page=true&limit=20";

  it("verifies against the published public key", () => {
    const headers = signedGetHeaders(URL_WITH_QUERY)!;
    expect(headers).not.toBeNull();
    expect(
      verifyAsRemote(URL_WITH_QUERY, headers, instanceActorPublicKeyPem()!),
    ).toBe(true);
  });

  it("the published key IS the signing key", () => {
    // The disagreement this catches is silent in the worst direction: we
    // publish a public key nothing we sign can be verified against, every
    // remote refuses us, and the actor document looks perfectly well-formed to
    // anyone who reads it. Hence derived-from-the-private-half, never a second
    // environment variable — and hence a stranger's key must fail.
    const headers = signedGetHeaders(URL_WITH_QUERY)!;
    const strangersKey = createPublicKey(
      Buffer.from(freshKeyB64(), "base64").toString("utf8"),
    )
      .export({ type: "spki", format: "pem" })
      .toString();
    expect(verifyAsRemote(URL_WITH_QUERY, headers, strangersKey)).toBe(false);
  });

  it("signs the query string, not the path alone", () => {
    // An outbox is paged with `?page=true&max_id=…`, so a signature over the
    // path alone verifies against a DIFFERENT request on every page after the
    // first — and the failure is a 401 from page two onwards, which reads
    // exactly like an instance that has rate-limited us.
    const headers = signedGetHeaders(URL_WITH_QUERY)!;
    const otherPage = URL_WITH_QUERY.replace("limit=20", "limit=40");
    expect(
      verifyAsRemote(otherPage, headers, instanceActorPublicKeyPem()!),
    ).toBe(false);
  });

  it("signs the port, because the receiver reconstructs Host with it", () => {
    const headers = signedGetHeaders(URL_WITH_QUERY)!;
    const noPort = URL_WITH_QUERY.replace("secure.example:8443", "secure.example");
    expect(verifyAsRemote(noPort, headers, instanceActorPublicKeyPem()!)).toBe(
      false,
    );
  });

  it("names the three headers it signed, and carries the Date it signed", () => {
    const headers = signedGetHeaders(URL_WITH_QUERY)!;
    const sig = parseSignature(headers.Signature);
    expect(sig.headers).toBe("(request-target) host date");
    expect(sig.algorithm).toBe("rsa-sha256");
    expect(sig.keyId).toBe("https://all.haus/actor#main-key");
    // A signature over a Date the request does not carry verifies against
    // nothing — the receiver reads the header, not our intention.
    expect(headers.Date).toBeTruthy();
    expect(new Date(headers.Date).toUTCString()).toBe(headers.Date);
  });

  it("mints a fresh date per request", async () => {
    // Receivers refuse a Date more than a few minutes off their own clock, so
    // a cached one works in every test and stops working in production after
    // the process has been up for an hour.
    const first = signedGetHeaders(URL_WITH_QUERY)!;
    await new Promise((r) => setTimeout(r, 1100));
    const second = signedGetHeaders(URL_WITH_QUERY)!;
    expect(second.Date).not.toBe(first.Date);
    // And the new date is the one that was signed, not the old one reused.
    expect(
      verifyAsRemote(URL_WITH_QUERY, second, instanceActorPublicKeyPem()!),
    ).toBe(true);
  });
});
