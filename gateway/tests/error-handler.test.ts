import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { gatewayErrorHandler } from "../src/lib/error-handler.js";

// =============================================================================
// What a client may read off a failed request.
//
// The subject is the funnel, not any one route: ~30 routes interpolate an
// unvalidated path id or `limit` into SQL, and Fastify's default handler puts
// Postgres's own message in the 500 body. Validating each input is the fix;
// this is the floor that stops the next route needing one.
//
// The real error is used, not a stand-in — a `pg` uuid-cast failure carries no
// `statusCode`, which is exactly the property the handler branches on, and a
// hand-rolled `new Error("boom")` would agree with the handler about that by
// luck rather than by construction. The test asserts what is IN the body, not
// just the status code: a 500 that still names the relation is the same
// disclosure wearing the right number.
// =============================================================================

/** The shape node-postgres actually throws for a bad cast. */
function pgCastError() {
  const err = new Error(
    'invalid input syntax for type uuid: "not-a-uuid"',
  ) as Error & { code?: string; routine?: string };
  err.code = "22P02";
  err.routine = "string_to_uuid";
  return err;
}

async function build() {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.setErrorHandler(gatewayErrorHandler);

  app.get("/db-throw", async () => {
    throw pgCastError();
  });
  app.get("/chosen-404", async (_req, reply) => {
    throw reply.notFound("No such piece");
  });
  app.get("/chosen-502", async (_req, reply) => {
    throw reply.badGateway("Couldn't reach the analytics service. Please try again in a moment.");
  });
  app.post("/echo", async () => ({ ok: true }));
  return app;
}

describe("gatewayErrorHandler", () => {
  it("does not put the database's message in the body", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/db-throw" });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBe("internal_error");
    expect(body.requestId).toBeTruthy();

    // The three things that leaked. Asserted against the raw payload rather
    // than the parsed body, so a message hidden in any field still fails.
    expect(res.payload).not.toContain("invalid input syntax");
    expect(res.payload).not.toContain("uuid");
    expect(res.payload).not.toContain("22P02");
    await app.close();
  });

  it("passes a status the route CHOSE through with its message intact", async () => {
    const app = await build();

    const notFound = await app.inject({ method: "GET", url: "/chosen-404" });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json().message).toBe("No such piece");

    await app.close();
  });

  it("keeps a chosen 5xx's status but not its message", async () => {
    // A 502 from an unreachable peer is a deliberate answer; the status is the
    // answer and the message is ours, so the status survives and the text
    // does not.
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/chosen-502" });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("internal_error");
    expect(res.payload).not.toContain("Couldn't reach the analytics service. Please try again in a moment.");
    await app.close();
  });

  it("leaves Fastify's own malformed-body 400 readable", async () => {
    // This one the client is meant to act on, and it is thrown rather than
    // returned — so it reaches the handler and must survive it.
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBeTruthy();
    await app.close();
  });
});
