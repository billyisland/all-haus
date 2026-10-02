import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  containsUrl,
  DM_NO_LINKS_MESSAGE,
} from "@platform-pub/shared/lib/sanitize.js";

// =============================================================================
// DIRECT MESSAGES ARE TEXT ONLY, AND THE ROUTE IS WHAT SAYS SO
// (L6.2, decision A1; D1 §5)
//
// A DM is the one surface where a stranger can put something in front of a
// member with nobody else in the room, and a link is what makes that worth
// doing at scale. The composer's upload button is gone and the thread renders
// plain text — but a UI that declines to draw a control is not an access
// control (posts.md, learned on `POST /replies` and `POST /votes`), so the
// refusal that matters is this one.
//
// WHAT IS ASSERTED, AND WHY IT IS NOT THE STATUS CODE. A route that refuses
// AFTER encrypting and writing the message has still written it. So every
// refusal case asserts that `sendMessage` WAS NEVER CALLED — the service is
// mocked and the assertion is on its call count. The status is checked too and
// never decides the case.
//
// THE FREE CONTROL IS THE ONE THAT MATTERS. A detector tightened into a
// blanket refusal stops everybody messaging, and a suite whose every fixture
// contains a URL goes green against it. Hence the plain-message case, and
// hence its assertion that the service WAS reached.
//
// MUTATION CHECK: delete the `containsUrl` branch in `routes/messages.ts` and
// the three refusal cases fail; make `containsUrl` return `true` always and
// the plain case fails.
// =============================================================================

const SENDER = "00000000-0000-4000-8000-0000000000a1";
const CONVERSATION = "00000000-0000-4000-8000-0000000000b2";

const sendMessage = vi.fn(async () => ({
  ok: true as const,
  data: { messageIds: ["00000000-0000-4000-8000-0000000000c3"] },
}));

vi.mock("../src/services/messages.js", () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...(a as [])),
  DM_REACTION_TYPES: ["like"] as const,
  createConversation: vi.fn(),
  listInbox: vi.fn(),
  loadConversationMessages: vi.fn(),
  markMessageRead: vi.fn(),
  markAllRead: vi.fn(),
  toggleReaction: vi.fn(),
  decryptBatch: vi.fn(),
  getDmPricing: vi.fn(),
  setDmDefaultPrice: vi.fn(),
  setDmOverride: vi.fn(),
  removeDmOverride: vi.fn(),
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: SENDER };
  },
  optionalAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: SENDER };
  },
}));

const { messageRoutes, DM_LINKS_REFUSED } = await import(
  "../src/routes/messages.js"
);

async function build() {
  const app = Fastify();
  await app.register(messageRoutes);
  return app;
}

function send(app: Awaited<ReturnType<typeof build>>, content: string) {
  return app.inject({
    method: "POST",
    url: `/messages/${CONVERSATION}`,
    payload: { content },
  });
}

beforeEach(() => {
  sendMessage.mockClear();
});

describe("POST /messages/:conversationId — text only", () => {
  it("refuses an https:// body, and writes NOTHING", async () => {
    const app = await build();
    const res = await send(app, "have a look at https://example.com/x");

    expect(sendMessage).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(DM_LINKS_REFUSED);
  });

  it("refuses a www. body and a schemeless scheme too", async () => {
    const app = await build();
    for (const body of ["see www.example.com", "mail me at mailto:a@b.co"]) {
      sendMessage.mockClear();
      const res = await send(app, body);
      expect(sendMessage, body).not.toHaveBeenCalled();
      expect(res.statusCode, body).toBe(400);
    }
  });

  it("SENDS a plain message — the control that catches a blanket refusal", async () => {
    const app = await build();
    const res = await send(app, "Meeting at 10:30am. The ratio was 3:2. Fine.");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(201);
  });

  it("tells the sender what to do about it, in a sentence and not a code", async () => {
    const app = await build();
    const res = await send(app, "https://example.com");
    // The web renders `message` through `apiErrorMessage`; a refusal that
    // arrives as a bare code renders as the generic "didn't send, try again",
    // and the sender presses Send on the same body for ever.
    expect(res.json().message).toBe(DM_NO_LINKS_MESSAGE);
    expect(DM_NO_LINKS_MESSAGE.length).toBeGreaterThan(20);
  });
});

describe("containsUrl — what it catches and what it deliberately does not", () => {
  it("catches every link shape a member could paste", () => {
    for (const s of [
      "https://x.co",
      "HTTP://X.CO",
      "wss://relay.example",
      "ftp://x.co",
      "see www.x.co now",
      "javascript:alert(1)",
      "data:text/html,x",
      "mailto:a@b.co",
    ]) {
      expect(containsUrl(s), s).toBe(true);
    }
  });

  it("leaves ordinary prose alone — a colon is not a scheme", () => {
    // Each of these was refused by an earlier, more general pattern. A member
    // told their message contained a link when it contained a full stop is a
    // worse failure than the one this guard exists to prevent.
    for (const s of [
      "Meeting at 10:30am",
      "the ratio was 3:2",
      "Note:something",
      "Q:answer",
      "Re: hello",
      "node.js is fine",
      "plain text with. full stops.",
    ]) {
      expect(containsUrl(s), s).toBe(false);
    }
  });
});
