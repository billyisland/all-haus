import { describe, it, expect } from "vitest";
import {
  BINDING_MAX_SKEW_MS,
  signInternalRequest,
  verifyInternalRequest,
} from "../src/lib/internal-binding.js";

// =============================================================================
// The per-request binding (MIRROR-AUDIT S15).
//
// Every case here is a hole the BEARER header left open, phrased as the capture
// that exploits it: an attacker who has one honest request off the wire and is
// trying to make it into a different one. A test that only checked the happy
// path would pass against an HMAC over the timestamp alone.
// =============================================================================

const SECRET = "s".repeat(48);
const T0 = 1_757_000_000_000;

const REQ = {
  method: "POST",
  path: "/api/v1/keypairs/sign",
  rawBody: JSON.stringify({ signerId: "acct-a", signerType: "account", event: { kind: 1 } }),
};

function capture(now = T0) {
  return signInternalRequest(SECRET, REQ, now);
}

describe("internal request binding", () => {
  it("accepts the request it was minted for", () => {
    expect(verifyInternalRequest(SECRET, capture(), REQ, T0)).toEqual({ ok: true });
  });

  it("refuses a request with no binding at all — the pre-S15 shape", () => {
    // The whole of the old contract: bearer header, nothing else. It has to be
    // refused rather than waved through, or the guard is decorative.
    expect(verifyInternalRequest(SECRET, undefined, REQ, T0)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(verifyInternalRequest(SECRET, "", REQ, T0)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("refuses a capture RETARGETED at another account", () => {
    // `/keypairs/export` returns an account's root nsec. Under a bearer header
    // this edit was the entire attack: same captured request, different uuid.
    // The subject is a field of the body, so the body hash is what refuses it —
    // there is no separate signer term in the tuple, deliberately (see the
    // module header).
    const header = capture();
    const retargeted = { ...REQ, rawBody: REQ.rawBody.replace("acct-a", "acct-b") };
    expect(verifyInternalRequest(SECRET, header, retargeted, T0)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("refuses a capture REPLAYED at another route", () => {
    // A captured `/keypairs/sign` must not become a `/keypairs/export`.
    const header = capture();
    expect(
      verifyInternalRequest(SECRET, header, { ...REQ, path: "/api/v1/keypairs/export" }, T0),
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses a capture whose BODY was edited in flight", () => {
    const header = capture();
    const tampered = { ...REQ, rawBody: REQ.rawBody.replace('"kind":1', '"kind":30023') };
    expect(verifyInternalRequest(SECRET, header, tampered, T0)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("refuses a capture replayed outside the freshness window, in EITHER direction", () => {
    const header = capture();
    // Inside, both ways.
    expect(verifyInternalRequest(SECRET, header, REQ, T0 + BINDING_MAX_SKEW_MS - 1).ok).toBe(true);
    expect(verifyInternalRequest(SECRET, header, REQ, T0 - BINDING_MAX_SKEW_MS + 1).ok).toBe(true);
    // Outside, both ways. A clock that has run backwards is as much a reason to
    // refuse as one that has run forwards — a future-dated binding would
    // otherwise be a capability that becomes valid later.
    expect(verifyInternalRequest(SECRET, header, REQ, T0 + BINDING_MAX_SKEW_MS + 1)).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(verifyInternalRequest(SECRET, header, REQ, T0 - BINDING_MAX_SKEW_MS - 1)).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("refuses a binding minted under a different secret", () => {
    const header = signInternalRequest("t".repeat(48), REQ, T0);
    expect(verifyInternalRequest(SECRET, header, REQ, T0)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("refuses a forged timestamp — the tag covers it, so moving it breaks it", () => {
    // The obvious way to beat the freshness window: keep the tag, restate the
    // timestamp. It fails as a mismatch and not as staleness, which is what
    // says the timestamp is inside the HMAC rather than beside it.
    const [version, , tag] = capture().split(".");
    const restamped = [version, String(T0 + 60_000), tag].join(".");
    expect(verifyInternalRequest(SECRET, restamped, REQ, T0 + 60_000)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("refuses malformed and wrong-version headers without throwing", () => {
    expect(verifyInternalRequest(SECRET, "garbage", REQ, T0)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyInternalRequest(SECRET, "v1.notanumber.aa", REQ, T0)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyInternalRequest(SECRET, `v2.${T0}.aa`, REQ, T0)).toEqual({
      ok: false,
      reason: "bad_version",
    });
  });

  it("binds a bodyless request to its path and stays verifiable", () => {
    // `POST /keypairs/generate` sends no body. The empty string is what both
    // sides hash; it must still be a real binding and not a free pass, which is
    // what the second assertion is for.
    const bodyless = { method: "POST", path: "/api/v1/keypairs/generate", rawBody: "" };
    const header = signInternalRequest(SECRET, bodyless, T0);
    expect(verifyInternalRequest(SECRET, header, bodyless, T0)).toEqual({ ok: true });
    expect(
      verifyInternalRequest(SECRET, header, { ...bodyless, path: "/api/v1/keypairs/export" }, T0),
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("does not leak the secret into the header", () => {
    // An HMAC tag is not the key. This is the property the whole change rests
    // on: capturing a request must not let you forge a different one.
    expect(capture()).not.toContain(SECRET);
  });
});
