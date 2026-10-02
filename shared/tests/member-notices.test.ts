import { describe, it, expect, beforeEach, vi } from "vitest";
// Every link in these emails is built from APP_URL at SEND time, with no
// fallback (§0ab residual) — a suite that leaves it unset throws, by design.
process.env.APP_URL = "https://test.all.haus";

// =============================================================================
// TELLING A MEMBER SOMETHING HAPPENED TO THEM (L5.5; Writer 8.3, 11.2; D5 §9,
// D7 §5).
//
// Two things this file is about, and the second is the load-bearing one.
//
//   (1) WHAT THE NOTICE SAYS. A chargeback notice that does not name the piece
//       or the amount is a notice a Writer cannot act on, and Writer 8.3
//       invites evidence — so the address to send it to has to be in it. A
//       moderation notice that does not carry the REASON is the thing D7 §5
//       exists to refuse.
//
//   (2) THE PARTIAL-OUTCOME RULE. One chargeback can reverse several Writers.
//       A bare `for … await` over a throwing send aborts at the first bad
//       address and records nothing about the rest — the waitlist-digest
//       failure, exactly. So the assertions are about what the OTHER writers
//       got, and about `skipped` being counted rather than swallowed. A test
//       that only checked the return value passes against the aborting loop.
//
// The recipient lookup is answered from `params`, not from the SQL: every
// lookup here is the same statement against the same table differing only in
// the id, so a mock keyed on the text would hand back the same person whoever
// was asked for — which is the trap the invariant's own example is about.
// =============================================================================

const db = vi.hoisted(() => ({
  accounts: new Map<string, { email: string | null; display_name: string | null }>(),
}));

const sendEmail = vi.hoisted(() => vi.fn(async () => undefined));
/** What `emailDeliverable()` answers — a real provider unless a case says not. */
const emailState = vi.hoisted(() => ({ deliverable: true }));

vi.mock("../src/db/client.js", () => ({
  pool: {
    query: async (_sql: string, params: unknown[] = []) => {
      const acc = db.accounts.get(params[0] as string);
      return {
        rows: acc ? [{ ...acc, username: "handle" }] : [],
        rowCount: acc ? 1 : 0,
      };
    },
  },
}));
vi.mock("../src/lib/email.js", () => ({
  sendEmail: (...a: unknown[]) => sendEmail(...(a as [])),
  emailDeliverable: () => emailState.deliverable,
}));
vi.mock("../src/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  sendChargebackNoticeEmails,
  sendModerationNoticeEmail,
  sendUnpayableWithdrawalNoticeEmail,
} = await import("../src/lib/member-notices.js");

function seed(id: string, email: string | null) {
  db.accounts.set(id, { email, display_name: `Writer ${id}` });
}

/** Every email the module actually sent, by recipient. */
function sentTo(email: string) {
  return sendEmail.mock.calls
    .map((c) => c[0] as { to: string; subject: string; htmlBody: string; textBody: string })
    .find((m) => m.to === email);
}

beforeEach(() => {
  db.accounts.clear();
  emailState.deliverable = true;
  sendEmail.mockClear();
  sendEmail.mockImplementation(async () => undefined);
});

// -----------------------------------------------------------------------------
describe("the chargeback notice (Writer 8.3)", () => {
  it("names the amount, the piece, and where to send evidence", async () => {
    seed("w1", "w1@example.com");

    const outcome = await sendChargebackNoticeEmails([
      { writerId: "w1", amountPence: 276, titles: ["The Lighthouse Keepers"] },
    ]);

    expect(outcome).toEqual({ sent: 1, skipped: 0 });
    const mail = sentTo("w1@example.com")!;
    expect(mail.htmlBody).toContain("£2.76");
    expect(mail.htmlBody).toContain("The Lighthouse Keepers");
    // The invitation is the clause's own promise, and an invitation with no
    // address is not one.
    expect(mail.htmlBody).toContain("support@all.haus");

    // BOTH HALVES SAY IT. The first draft of this file asserted on a field
    // called `html`, which `sendEmail` does not have — so the notice would have
    // gone out with an empty HTML body and every assertion here would still
    // have passed. A Writer reading this in a text client is reading the same
    // facts, so the text half carries the amount and the piece too.
    expect(mail.textBody).toContain("£2.76");
    expect(mail.textBody).toContain("The Lighthouse Keepers");
    expect(mail.textBody).toContain("support@all.haus");
  });

  it("escapes a title — a piece is named by its author, not by us", async () => {
    seed("w1", "w1@example.com");

    await sendChargebackNoticeEmails([
      { writerId: "w1", amountPence: 100, titles: ["<script>alert(1)</script>"] },
    ]);

    const mail = sentTo("w1@example.com")!;
    expect(mail.htmlBody).not.toContain("<script>");
    expect(mail.htmlBody).toContain("&lt;script&gt;");
  });
});

describe("the loop is a partial outcome, never a total one", () => {
  it("one unreachable writer does not stop the others being told", async () => {
    seed("w1", "w1@example.com");
    seed("w2", "w2@example.com");
    seed("w3", "w3@example.com");
    // The middle one throws, as a provider rejecting one address does.
    sendEmail.mockImplementation(async (params: unknown) => {
      if ((params as { to: string }).to === "w2@example.com") {
        throw new Error("550 mailbox unavailable");
      }
      return undefined;
    });

    const outcome = await sendChargebackNoticeEmails([
      { writerId: "w1", amountPence: 100, titles: ["One"] },
      { writerId: "w2", amountPence: 200, titles: ["Two"] },
      { writerId: "w3", amountPence: 300, titles: ["Three"] },
    ]);

    // THE ASSERTION THAT CATCHES THE ABORTING LOOP: what the writer AFTER the
    // failure got. A status-only check passes against a loop that stopped.
    expect(sentTo("w3@example.com")).toBeTruthy();
    expect(sentTo("w3@example.com")!.htmlBody).toContain("£3.00");
    expect(outcome).toEqual({ sent: 2, skipped: 1 });
  });

  it("counts a writer with no address rather than passing over them in silence", async () => {
    seed("w1", null); // a seeded account, or a signup path that collects none
    seed("w2", "w2@example.com");

    const outcome = await sendChargebackNoticeEmails([
      { writerId: "w1", amountPence: 100, titles: ["One"] },
      { writerId: "w2", amountPence: 200, titles: ["Two"] },
    ]);

    expect(outcome.sent).toBe(1);
    // `skipped` beside `sent` is what tells "nobody was affected" from "nobody
    // could be reached".
    expect(outcome.skipped).toBe(1);
  });

  it("a TOTAL outage reports as one — every writer skipped, none sent", async () => {
    seed("w1", "w1@example.com");
    seed("w2", "w2@example.com");
    sendEmail.mockImplementation(async () => {
      throw new Error("provider down");
    });

    const outcome = await sendChargebackNoticeEmails([
      { writerId: "w1", amountPence: 100, titles: [] },
      { writerId: "w2", amountPence: 200, titles: [] },
    ]);

    expect(outcome).toEqual({ sent: 0, skipped: 2 });
  });

  it("answers the lookup from the PARAMS — two writers are two people", async () => {
    // Every recipient lookup is the same statement against the same table,
    // differing only in the id. Keyed on the SQL, a mock hands back one person
    // for both and transposing the two ids stays green.
    seed("w1", "w1@example.com");
    seed("w2", "w2@example.com");

    await sendChargebackNoticeEmails([
      { writerId: "w1", amountPence: 111, titles: [] },
      { writerId: "w2", amountPence: 222, titles: [] },
    ]);

    expect(sentTo("w1@example.com")!.htmlBody).toContain("£1.11");
    expect(sentTo("w2@example.com")!.htmlBody).toContain("£2.22");
  });
});

// -----------------------------------------------------------------------------
describe("the moderation notice (D5 §9, D7 §5)", () => {
  it("carries the reason as given, and how to challenge it", async () => {
    seed("m1", "m1@example.com");

    const outcome = await sendModerationNoticeEmail(
      "m1",
      "account_suspended",
      "repeatedly posting work that is not yours",
    );

    expect(outcome).toEqual({ sent: 1, skipped: 0 });
    const mail = sentTo("m1@example.com")!;
    expect(mail.subject).toContain("suspended");
    // The reason as given: a member told only "you breached the guidelines"
    // has been told nothing they can answer.
    expect(mail.htmlBody).toContain("repeatedly posting work that is not yours");
    expect(mail.htmlBody).toContain("support@all.haus");
    // The text half carries the reason too — see the chargeback case above.
    expect(mail.textBody).toContain("Why: repeatedly posting work that is not yours");
  });

  it("ESCAPES the reason — an operator's sentence is not markup", async () => {
    // The reason is free text an operator typed, and it lands in an HTML body.
    // Escaped, not stripped: the member must read exactly what was written
    // about them, including the punctuation.
    seed("m1", "m1@example.com");

    await sendModerationNoticeEmail("m1", "content_removed", "it's <b>spam</b>");

    const mail = sentTo("m1@example.com")!;
    expect(mail.htmlBody).not.toContain("<b>spam</b>");
    expect(mail.htmlBody).toContain("&lt;b&gt;spam&lt;/b&gt;");
    expect(mail.htmlBody).toContain("it&#39;s");
  });

  it("a removal and a suspension say different things", async () => {
    seed("m1", "m1@example.com");
    seed("m2", "m2@example.com");

    await sendModerationNoticeEmail("m1", "content_removed", "off-topic");
    await sendModerationNoticeEmail("m2", "account_suspended", "off-topic");

    expect(sentTo("m1@example.com")!.htmlBody).not.toContain("cannot sign in");
    expect(sentTo("m2@example.com")!.htmlBody).toContain("cannot sign in");
  });

  it("every decision against an account says what happens to money owed (L8.6)", async () => {
    // Writer 6.6: a suspension or a closure pauses payouts. A member told only
    // that they cannot sign in learns about the pause from a payout that never
    // arrives — which is the class this whole sequence exists to end.
    //
    // The three kinds say three DIFFERENT things because three different
    // things happen: a 7-day suspension resumes by itself, an indefinite one
    // resumes on reinstatement, and a closure needs the member to ask. A test
    // that only looked for "held for you" would pass against one sentence
    // pasted into all three.
    seed("s7", "s7@example.com");
    seed("si", "si@example.com");
    seed("tm", "tm@example.com");
    seed("ri", "ri@example.com");

    await sendModerationNoticeEmail("s7", "account_suspended_7d", "off-topic");
    await sendModerationNoticeEmail("si", "account_suspended", "off-topic");
    await sendModerationNoticeEmail("tm", "account_terminated", "off-topic");
    await sendModerationNoticeEmail("ri", "account_reinstated", "we got it wrong");

    const sevenDay = sentTo("s7@example.com")!.htmlBody;
    expect(sevenDay).toContain("held for you");
    expect(sevenDay).toContain("payouts resume when the suspension lifts");

    const indefinite = sentTo("si@example.com")!.htmlBody;
    expect(indefinite).toContain("held for you");
    expect(indefinite).toContain("paused while the suspension stands");

    const closed = sentTo("tm@example.com")!.htmlBody;
    expect(closed).toContain("held for you");
    expect(closed).toContain("we will pay you what you are owed");

    // And the release is announced too, or a reinstated member has no reason
    // to expect the money back.
    expect(sentTo("ri@example.com")!.htmlBody).toContain("are released");
  });

  it("a reinstatement offers no appeal, and says the content is still gone", async () => {
    seed("m1", "m1@example.com");

    await sendModerationNoticeEmail("m1", "account_reinstated", "we got it wrong");

    const mail = sentTo("m1@example.com")!;
    expect(mail.htmlBody).toContain("reinstated");
    // The honest half: reinstating restores nothing, because a tombstone has
    // already left the building.
    expect(mail.htmlBody).toContain("stays removed");
    expect(mail.htmlBody).not.toContain("got this wrong");
  });

  it("reports a member with no address as skipped, and does not throw", async () => {
    seed("m1", null);

    await expect(
      sendModerationNoticeEmail("m1", "account_suspended", "reason"),
    ).resolves.toEqual({ sent: 0, skipped: 1 });
  });

  it("a provider outage does not throw into the moderation action", async () => {
    // A member who cannot be emailed must not also be left un-moderated: the
    // suspension has committed by the time this runs.
    seed("m1", "m1@example.com");
    sendEmail.mockImplementation(async () => {
      throw new Error("provider down");
    });

    await expect(
      sendModerationNoticeEmail("m1", "account_suspended", "reason"),
    ).resolves.toEqual({ sent: 0, skipped: 1 });
  });
});

describe("the unpayable withdrawal notice — a log line is not notice (§0z item 7)", () => {
  // The `console` provider resolves normally, so the send "succeeds" and
  // nothing arrives. Every other notice here may be a lost email; this one is
  // the precondition of a withdrawal (Writer 9.3), and the sweep stamps its
  // record on `sent > 0` — so `sent` has to mean DELIVERED.
  it("reports NOT sent, and never calls the sender, when no real provider is configured", async () => {
    seed("w1", "w1@example.com");
    emailState.deliverable = false;

    const outcome = await sendUnpayableWithdrawalNoticeEmail("w1", 30);
    // Pre-fix: { sent: 1 } — the sweep stamped, and withdrew 30 days later.
    expect(outcome).toEqual({ sent: 0, skipped: 1 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("control: with a real provider the notice goes and counts as sent", async () => {
    seed("w1", "w1@example.com");

    const outcome = await sendUnpayableWithdrawalNoticeEmail("w1", 30);
    expect(outcome).toEqual({ sent: 1, skipped: 0 });
    const mail = sentTo("w1@example.com");
    expect(mail).toBeDefined();
    expect(mail!.textBody).toContain("in 30 days we will stop offering paid access");
  });

  it("a provider whose send THROWS is not sent either — the existing contract", async () => {
    seed("w1", "w1@example.com");
    sendEmail.mockImplementation(async () => {
      throw new Error("POSTMARK_API_KEY not set");
    });

    const outcome = await sendUnpayableWithdrawalNoticeEmail("w1", 30);
    expect(outcome).toEqual({ sent: 0, skipped: 1 });
  });
});
