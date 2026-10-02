import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

// =============================================================================
// The gateway's one error funnel.
//
// Fastify's default handler answers an uncaught throw with
// `{statusCode: 500, error: "Internal Server Error", message: err.message}` —
// and for the throw that actually happens here, `err.message` is Postgres's:
// `invalid input syntax for type uuid: "…"`, a constraint name, a column list,
// a relation that exists. Roughly thirty routes interpolated an unvalidated
// path id or `limit` straight into a query, so that body was one malformed
// request away on any of them, and every route written next inherits the same
// default.
//
// Validating those inputs is the right fix and is done at the routes (S18);
// this is the floor underneath it, because a floor is what stops the NEXT
// route being written without one. Two rules:
//
//   · A status a route CHOSE is passed through untouched. 4xx here is
//     `@fastify/sensible`'s `httpErrors`, the rate limiter's 429/403, a body
//     over the multipart limit's 413, Fastify's own malformed-JSON 400 — those
//     messages are ours and are what the client is meant to read. Rewriting
//     them would change the meaning of every client-side error branch in the
//     web at once, which is why this deliberately invents no new envelope.
//
//   · Anything else is a fault of OURS, so it answers a fixed body and the
//     detail goes to the log, keyed to the request id the response also
//     carries. Same split as the terminal/ambiguous classifiers, one layer
//     out: the ordinary refusal and the broken deployment must not be
//     indistinguishable — and here it is the CLIENT that must not be able to
//     tell them apart, while the operator still can.
//
// The status is read off the error rather than assumed, because a 5xx a route
// chose (a 502 from an unreachable peer, a 503 from a halted cycle) is also a
// deliberate answer; what it must not carry is the message.
// =============================================================================

/** Errors reaching here have a statusCode only if something SET one. */
interface MaybeStatused {
  statusCode?: number;
}

export function gatewayErrorHandler(
  err: FastifyError,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const status = (err as MaybeStatused).statusCode;

  if (typeof status === "number" && status >= 400 && status < 500) {
    // Passed through as Fastify's default would have serialised it. Logged at
    // info: a refusal is an ordinary outcome, not an incident.
    req.log.info({ err, status }, "request refused");
    return reply.status(status).send(err);
  }

  req.log.error(
    { err, url: req.url, method: req.method },
    "unhandled route error",
  );
  return reply
    .status(typeof status === "number" && status >= 500 ? status : 500)
    .send({ error: "internal_error", requestId: req.id });
}
