import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { createVerify, createPublicKey, generateKeyPairSync } from "node:crypto";
import { instanceActorRoutes } from "../src/routes/instance-actor.js";
import {
  resetApSigningKeyCache,
  signedGetHeaders,
  INSTANCE_ACTOR_PATH,
  INSTANCE_ACTOR_INBOX_PATH,
} from "@platform-pub/shared/lib/http-signature.js";

// =============================================================================
// The instance actor route — the far end of our own signature
//
// THE ONE ASSERTION THAT MATTERS is the last one: sign a request with the
// platform's key, then verify it with the public key read OUT OF THIS ROUTE'S
// RESPONSE, exactly as a receiving instance does. Everything else here is
// shape; that case is the chain. It fails if the document publishes a
// different key, if `keyId` names a path this route does not serve, or if the
// signing string drifts — and every one of those failures presents on the far
// side as the same thing, "your signature does not verify", which is
// indistinguishable from an instance that has simply blocked us.
//
// A test that asserted `publicKey.publicKeyPem` merely "is a PEM" would pass
// against a key we never sign with.
// =============================================================================

const KEY_ENV = "AP_INSTANCE_PRIVATE_KEY_B64";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY_B64 = Buffer.from(
  privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  "utf8",
).toString("base64");

const savedKey = process.env[KEY_ENV];
const savedApp = process.env.APP_URL;

async function build() {
  const app = Fastify();
  await app.register(instanceActorRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  process.env.APP_URL = "https://all.haus";
  process.env[KEY_ENV] = KEY_B64;
  resetApSigningKeyCache();
});

afterEach(() => {
  if (savedKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = savedKey;
  if (savedApp === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedApp;
  resetApSigningKeyCache();
});

describe("the served paths are the signed paths (§0ab guard (a))", () => {
  // The registrations spell their paths as literals for the nginx guard, so
  // the agreement with the constants the SIGNER uses is asked of the router at
  // `onReady`. Registered under a prefix, the gateway serves `/ap/actor` while
  // every signature names `/actor` — and the boot must refuse rather than go
  // on signing requests nobody can verify.
  it("refuses to become ready when the routes are not where keyId points", async () => {
    const app = Fastify();
    await app.register(instanceActorRoutes, { prefix: "/ap" });
    await expect(app.ready()).rejects.toThrow(/Instance actor path drift/);
  });

  it("control: registered as index.ts registers it, it is ready", async () => {
    const app = await build();
    expect(app.hasRoute({ method: "GET", url: INSTANCE_ACTOR_PATH })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: INSTANCE_ACTOR_INBOX_PATH })).toBe(true);
    await app.close();
  });
});

describe("GET /actor", () => {
  it("serves an Application actor naming its own key", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/actor" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/activity+json");
    const doc = res.json();
    expect(doc.id).toBe("https://all.haus/actor");
    expect(doc.type).toBe("Application");
    // The fragment `keyId` names must be the one the document declares, or a
    // verifier fetching `…/actor#main-key` finds no key at that name.
    expect(doc.publicKey.id).toBe("https://all.haus/actor#main-key");
    expect(doc.publicKey.owner).toBe(doc.id);
    // Declared because the spec requires it and some implementations refuse a
    // document without one before they ever look at the key.
    expect(doc.inbox).toBe("https://all.haus/actor/inbox");
    await app.close();
  });

  it("answers 503 NAMING THE VARIABLE when no key is configured", async () => {
    // Never 404. A 404 is indistinguishable from the route not existing —
    // which is the failure this whole feature is about — so an operator
    // checking whether the deploy is finished gets an answer rather than a
    // mystery.
    delete process.env[KEY_ENV];
    resetApSigningKeyCache();
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/actor" });
    expect(res.statusCode).toBe(503);
    expect(res.json().detail).toContain("AP_INSTANCE_PRIVATE_KEY_B64");
    await app.close();
  });

  it("PUBLISHES THE KEY IT SIGNS WITH — verified the way a remote instance does", async () => {
    const app = await build();
    const doc = (await app.inject({ method: "GET", url: "/actor" })).json();
    await app.close();

    const target = "https://secure.example/users/alice/outbox?page=true";
    const headers = signedGetHeaders(target)!;
    const sig = Object.fromEntries(
      [...headers.Signature.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [
        m[1],
        m[2],
      ]),
    );

    // The verifier goes to `keyId` for the key. That URL must be THIS document.
    expect(sig.keyId).toBe(doc.publicKey.id);

    const parsed = new URL(target);
    const signingString = sig.headers
      .split(" ")
      .map((name) =>
        name === "(request-target)"
          ? `(request-target): get ${parsed.pathname}${parsed.search}`
          : name === "host"
            ? `host: ${parsed.host}`
            : `date: ${headers.Date}`,
      )
      .join("\n");

    expect(
      createVerify("RSA-SHA256")
        .update(signingString)
        .verify(
          createPublicKey(doc.publicKey.publicKeyPem),
          sig.signature,
          "base64",
        ),
    ).toBe(true);
  });
});

describe("the routes and the signatures agree on the paths", () => {
  it("the literals this file registers are the constants keyId is built from", async () => {
    // Two spellings of one URL disagree silently, and the symptom is "signing
    // does not work" with nothing anywhere saying why. The paths are literals
    // in the route file because `nginx-reachability.test.ts` reads the SOURCE
    // for quoted paths and cannot see a constant — a route registered as
    // `app.get(SOME_CONST, …)` is invisible to it, so the guard passes while
    // the route 404s from the wrong server. This is the seam that leaves.
    const app = await build();
    expect(
      app.hasRoute({ method: "GET", url: INSTANCE_ACTOR_PATH }),
    ).toBe(true);
    expect(
      app.hasRoute({ method: "POST", url: INSTANCE_ACTOR_INBOX_PATH }),
    ).toBe(true);
    await app.close();
  });
});

describe("GET /.well-known/webfinger", () => {
  it("answers for the instance actor, pointing at the actor document", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/.well-known/webfinger?resource=acct:allhaus@all.haus",
    });
    expect(res.statusCode).toBe(200);
    const jrd = res.json();
    expect(jrd.subject).toBe("acct:allhaus@all.haus");
    expect(jrd.links[0]).toMatchObject({
      rel: "self",
      type: "application/activity+json",
      href: "https://all.haus/actor",
    });
    await app.close();
  });

  it("answers for NOBODY ELSE, members included", async () => {
    // Making members fediverse-addressable is a product decision with
    // consequences for their privacy and for what we would then owe the
    // network. This route is not that decision, and a version of it that
    // answered for members would be a different feature with a different
    // review rather than a widening of this one.
    const app = await build();
    for (const resource of [
      "acct:alice@all.haus",
      "acct:allhaus@somewhere.else",
      "https://all.haus/actor",
      "",
    ]) {
      const res = await app.inject({
        method: "GET",
        url: `/.well-known/webfinger?resource=${encodeURIComponent(resource)}`,
      });
      expect(res.statusCode, `resource=${resource}`).toBe(404);
    }
    // And with no `resource` at all.
    const bare = await app.inject({
      method: "GET",
      url: "/.well-known/webfinger",
    });
    expect(bare.statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /actor/inbox", () => {
  it("accepts and discards — 202, empty body", async () => {
    // Deliberately a black hole: we send no Follow and act on nothing anyone
    // delivers. 202 is the honest code for "taken, with no further result to
    // report"; refusing instead makes well-behaved servers retry for days over
    // a delivery we were never going to read.
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/actor/inbox",
      payload: { type: "Follow", actor: "https://elsewhere.example/users/bob" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe("");
    await app.close();
  });
});
