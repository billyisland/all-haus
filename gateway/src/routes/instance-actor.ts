import type { FastifyInstance } from "fastify";
import {
  instanceActorId,
  instanceActorPublicKeyPem,
  INSTANCE_ACTOR_PATH,
  INSTANCE_ACTOR_INBOX_PATH,
  INSTANCE_ACTOR_USERNAME,
} from "@platform-pub/shared/lib/http-signature.js";

// =============================================================================
// The instance actor — what makes an outbound HTTP Signature verifiable
//
// A secure-mode fediverse server (`AUTHORIZED_FETCH` and its equivalents)
// answers an unsigned ActivityPub GET with 401. We sign those reads
// (`shared/lib/http-signature.ts`), and a signature is worth nothing unless
// the verifier can fetch the public half: it takes `keyId` off our Signature
// header, GETs it, and reads `publicKey.publicKeyPem`. THAT GET LANDS HERE.
// Missing route, missing nginx location, or a key that is not the one we
// signed with, and every signed request is refused — leaving the platform
// exactly as locked out as it was before, which is the failure this whole line
// of work exists to end.
//
// An `Application` actor, not a `Person`: it posts nothing, follows nobody and
// stands for the service rather than for a member. Mastodon, Akkoma and
// GoToSocial all serve the same shape at the same kind of path.
//
// WHY THE PATHS ARE LITERALS HERE AND CONSTANTS THERE. `nginx-reachability`
// derives the set of routes nginx must expose by READING THIS SOURCE for
// quoted paths, so a route registered as `app.get(SOME_CONST, …)` is invisible
// to it — the guard passes while the route 404s from the wrong server, which
// is the exact bug it was written for and one this file committed in its first
// draft. (It committed it a second time, more quietly: the paths moved into
// local constants and the guard went on finding `/actor` only because the
// regex ran on from THIS COMMENT into a quote — §0ab guard (a). The guard now
// strips comments first.) So each registration spells its path, and the
// `onReady` check at the foot of the plugin asks the ROUTER — not a second
// spelling — whether the paths the signatures name are served: a signature
// whose `keyId` names a path the gateway does not serve verifies against
// nothing, silently, everywhere, so a drift fails the boot instead.
// =============================================================================

export async function instanceActorRoutes(app: FastifyInstance) {
  // SERVED WHETHER OR NOT A KEY IS CONFIGURED, and it says which. A 404 here
  // would be indistinguishable from the route not existing — the failure this
  // is all about — so an unconfigured platform answers 503 naming the variable.
  // Nobody outside will read that body; the operator checking whether the
  // deploy is finished will.
  app.get("/actor", async (_req, reply) => {
    const publicKeyPem = instanceActorPublicKeyPem();
    const id = instanceActorId();
    if (!publicKeyPem || !id) {
      return reply.status(503).send({
        error: "activitypub_signing_not_configured",
        detail:
          "Set AP_INSTANCE_PRIVATE_KEY_B64 (and APP_URL) — see DEPLOYMENT.md.",
      });
    }
    reply
      .type("application/activity+json")
      .header("Cache-Control", "public, max-age=3600");
    const origin = new URL(id).origin;
    return {
      "@context": [
        "https://www.w3.org/ns/activitystreams",
        "https://w3id.org/security/v1",
      ],
      id,
      type: "Application",
      preferredUsername: INSTANCE_ACTOR_USERNAME,
      // Declared because the ActivityPub spec requires an actor to have one and
      // some implementations refuse a document without one before they ever
      // look at the key. What it DOES is one route down.
      inbox: `${origin}${INSTANCE_ACTOR_INBOX_PATH}`,
      url: origin,
      publicKey: {
        id: `${id}#main-key`,
        owner: id,
        publicKeyPem,
      },
    };
  });

  // DELIBERATELY A BLACK HOLE, and said out loud.
  //
  // We send no Follow and act on nothing anyone delivers, so everything that
  // arrives here is unsolicited. It is accepted and discarded: 202 is the
  // honest code for "taken, with no further result to report", and refusing
  // instead makes well-behaved servers retry on a schedule for days over a
  // delivery we were never going to read.
  //
  // NOTHING IS STORED AND NOTHING IS PARSED. Inbox ingest — deletes, Follow
  // handshakes, delivery-driven updates — is a real feature and a parked one
  // (FEED-INGEST-ATTACK-PLAN slice 7, posture-gated). When it is built it
  // REPLACES this handler. Do not add "just a little" handling here on the
  // assumption that deliveries are already being kept: they are not, and this
  // comment is the only thing that says so.
  app.post(
    "/actor/inbox",
    {
      bodyLimit: 1024 * 1024,
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    },
    async (_req, reply) => reply.status(202).send(),
  );

  // WebFinger — for the instance actor ALONE.
  //
  // Some implementations webfinger a signing actor before trusting it. This
  // answers for exactly one name and 404s for every other, INCLUDING every
  // member's username. Making members fediverse-addressable is a product
  // decision with consequences for their privacy and for what we would then
  // owe the network; it is not this, and a version of this route that answered
  // for members would be a different feature with a different review rather
  // than a widening of this one.
  app.get<{ Querystring: { resource?: string } }>(
    "/.well-known/webfinger",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const id = instanceActorId();
      const host = id ? new URL(id).host : null;
      const wanted = (req.query.resource ?? "").trim().toLowerCase();
      if (!id || !host || wanted !== `acct:${INSTANCE_ACTOR_USERNAME}@${host}`) {
        return reply.status(404).send({ error: "not_found" });
      }
      reply
        .type("application/jrd+json")
        .header("Cache-Control", "public, max-age=3600");
      return {
        subject: `acct:${INSTANCE_ACTOR_USERNAME}@${host}`,
        links: [{ rel: "self", type: "application/activity+json", href: id }],
      };
    },
  );

  // The paths the signatures name are the paths served — asked of the router
  // once every route above has landed in it (Fastify adds them after the
  // plugin body returns, so a check at this line would see none).
  app.addHook("onReady", async () => {
    const served =
      app.hasRoute({ method: "GET", url: INSTANCE_ACTOR_PATH }) &&
      app.hasRoute({ method: "POST", url: INSTANCE_ACTOR_INBOX_PATH });
    if (!served) {
      throw new Error(
        `Instance actor path drift: signatures name ${INSTANCE_ACTOR_PATH} and ` +
          `${INSTANCE_ACTOR_INBOX_PATH}, and the gateway does not serve both`,
      );
    }
  });
}
