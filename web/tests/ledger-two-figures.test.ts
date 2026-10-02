import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// =============================================================================
// Two figures, never a net — a grep over the copy, not over the code.
//
// Reader Terms 11.1: "Your reading and your writing are separate. Money you
// earn as a Writer is not set off against what you owe as a Reader, and vice
// versa. You cannot pay a reading tab out of your earnings."
// Reader Terms 4.3: a credit "will be refunded to the payment method it came
// from. We will not show it to you as a balance or let you spend it."
//
// Both were false on the live Ledger. `LedgerPanel` computed
// `pendingTransferPence − tabBalance` and handed it to `BalanceHeader` as one
// figure labelled "Net balance", which then read a positive net as "In credit —
// this is yours" — the set-off 11.1 refuses, presented as the wallet 4.3
// refuses, with the Explain caption ("what you've earned minus what you've
// spent") teaching it as the model.
//
// WHY THE CHECK IS OVER COPY AND NOT OVER THE FILE. The queue item asks for a
// grep of these files for "net" and "this is yours". A blunt grep cannot pass:
// the comments in all three files now explain the ban, in those words, at
// length — and a rule whose own explanation trips it is a rule that gets
// deleted. So the scan takes the ellipsis test's two passes (string literals,
// then the residue once they are blanked, which is JSX text) and reads only
// what a member can read.
//
// AND IT ASSERTS THE REPLACEMENT IS PRESENT. "No banned phrase survives" is
// equally true of a file this test failed to find, a component someone renamed,
// and a surface deleted outright. The required phrases are what tell those
// apart — the trap this repo keeps meeting, one level down.
// =============================================================================

const SRC = path.resolve(__dirname, "..", "src");

const BALANCE_HEADER = "components/account/BalanceHeader.tsx";
const LEDGER_PANEL = "components/account/LedgerPanel.tsx";
const EXPLAIN_COPY = "lib/explain/copy.ts";
// Named by the queue item as a fourth netting site. It is not one — the delete
// modal already states the charge and the held earnings as two separate facts
// ("Charge your card for anything outstanding on your reading tab" / "It does
// not send any unpaid earnings — those stay held"), which is 11.1 as written.
// It is scanned anyway, so that a future edit cannot quietly pair them.
const DANGER_ZONE = "components/account/DangerZone.tsx";

// The words BalanceHeader renders live here since the plain register
// (/modernhaus) states the same figures; the header only places them.
const LEDGER_COPY = "content/ledger.ts";

// DangerZone's words (the delete list and the held-earnings sentence) live
// here since the plain register (/modernhaus) states them too.
const SETTINGS_COPY = "content/settings.ts";

const SURFACES = [BALANCE_HEADER, LEDGER_PANEL, EXPLAIN_COPY, DANGER_ZONE, LEDGER_COPY, SETTINGS_COPY];

const STRING_RE = /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`)/g;

/**
 * Every fragment of a file a member can actually read: the string literals,
 * plus whatever is left on the line once they are blanked (JSX text), with a
 * trailing comment cut from that residue. Blanking the literals first is what
 * makes the comment cut safe — a URL's own `//` goes with its string.
 */
function visibleCopy(file: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const lines = readFileSync(path.join(SRC, file), "utf8").split("\n");
  lines.forEach((line, i) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    let residue = line;
    for (const m of line.matchAll(STRING_RE)) {
      out.push({ line: i + 1, text: m[0] });
      residue = residue.replace(m[0], " ".repeat(m[0].length));
    }
    const cut = residue.search(/\/\/|\/\*/);
    out.push({ line: i + 1, text: cut === -1 ? residue : residue.slice(0, cut) });
  });
  return out;
}

// Each is a phrase that states, or invites, the set-off. "in credit" is here
// because a credit named as a standing of the account IS a balance, which is
// the half of 4.3 that is about words rather than about money.
const BANNED = [
  "net balance",
  "this is yours",
  "in credit",
  "earned minus",
  "minus what you",
  "nothing owed either way",
];

describe("the Ledger states two figures and never nets them", () => {
  it("finds every surface it is meant to be scanning", () => {
    // A renamed or moved file would make every assertion below pass by reading
    // nothing. Reading the file is what proves it is there.
    for (const file of SURFACES) {
      expect(() => readFileSync(path.join(SRC, file), "utf8"), file).not.toThrow();
      expect(visibleCopy(file).length, file).toBeGreaterThan(10);
    }
  });

  it("carries no netting phrase in anything a member reads", () => {
    const hits: string[] = [];
    for (const file of SURFACES) {
      for (const { line, text } of visibleCopy(file)) {
        const haystack = text.toLowerCase();
        for (const phrase of BANNED) {
          if (haystack.includes(phrase)) hits.push(`${file}:${line} — "${phrase}" in ${text.trim()}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("names both figures, separately, on the header", () => {
    const copy = visibleCopy(LEDGER_COPY).map((c) => c.text).join("\n");
    // The two labels the member reads. Without these the check above passes on
    // a header that renders no figures at all.
    expect(copy).toContain("You owe");
    expect(copy).toContain("You are owed");
    // Reader Terms 4.3 in its own words: a refund going back the way it came,
    // on its own line, never a standing the account has.
    expect(copy).toContain("Refund due");
    expect(copy).toMatch(/return this to the card it came from/i);
    expect(copy).toMatch(/isn’t a balance/i);
  });

  it("the header renders the lifted labels, not copies of them", () => {
    const header = readFileSync(path.join(SRC, BALANCE_HEADER), "utf8");
    // A header that stopped importing the labels and spelled its own would
    // pass the copy checks above (they read content/ledger.ts) while the
    // Ledger said something else.
    for (const name of ["LEDGER_OWE_LABEL", "LEDGER_OWED_LABEL", "LEDGER_REFUND_LABEL", "LEDGER_REFUND_HELP"]) {
      expect(header, name).toMatch(new RegExp(`\\{${name}\\}`));
    }
  });

  it("shows the refund BESIDE the tab, never instead of it", () => {
    const header = readFileSync(path.join(SRC, BALANCE_HEADER), "utf8");
    // A reader can owe us for today's reading AND be owed a refund from last
    // month's billing error. Gating one on the other would be the netting this
    // file exists to refuse, re-expressed as a layout — which is what the first
    // version of this header did, displacing the tab figure entirely whenever
    // the balance went negative. There are no negative balances now: the
    // payable is its own value on the wire.
    expect(header).toMatch(/const showRefund = refundDuePence > 0/);
    expect(header).not.toMatch(/inCredit/);
    expect(header).toMatch(/refundDuePence: number/);
  });

  it("hands the header two values rather than one", () => {
    const panel = readFileSync(path.join(SRC, LEDGER_PANEL), "utf8");
    // The props are the wire between the two files: one figure in means the
    // subtraction happened upstream, whatever the header then calls it.
    expect(panel).toMatch(/tabBalancePence=\{tabBalance\}/);
    expect(panel).toMatch(/pendingEarningsPence=\{earningsPence\}/);
    // The payable is its own value on the wire (migration 206), never inferred
    // from a negative tab — there are no negative tabs any more.
    expect(panel).toMatch(/refundDuePence=\{tab\?\.refundDuePence \?\? 0\}/);
    expect(panel).not.toMatch(/balancePence=\{netBalance\}/);
  });

  it("does no arithmetic between the tab and the earnings, in either file", () => {
    for (const file of [LEDGER_PANEL, BALANCE_HEADER]) {
      const source = readFileSync(path.join(SRC, file), "utf8");
      const offenders = source
        .split("\n")
        .map((line, i) => ({ line: i + 1, code: line }))
        // Comments in both files quote the old expression on purpose.
        .filter(({ code }) => {
          const t = code.trimStart();
          return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
        })
        .filter(({ code }) =>
          /\b(earningsPence|pendingEarningsPence|pendingTransferPence)\b\s*[-+]/.test(code) ||
          /[-+]\s*\b(tabBalance|tabBalancePence)\b/.test(code),
        )
        .map(({ line, code }) => `${file}:${line} — ${code.trim()}`);
      expect(offenders).toEqual([]);
    }
  });

  it("explains the two figures as two, in the Explain caption", () => {
    const caption = visibleCopy(EXPLAIN_COPY)
      .map((c) => c.text)
      .find((t) => t.includes("what you owe on your reading tab"));
    expect(caption, "the ledger.balance caption").toBeDefined();
    expect(caption).toMatch(/Neither one pays the other/);
  });
});

// =============================================================================
// The wire's own types, for the two figures the header compares STRICTLY.
//
// `ledger_reader_balance.balance_pence` and `reader_credits.amount_pence` are
// both `bigint`, and node-postgres hands a bigint back as a STRING. The route's
// interface has always said `number`, so the value crossed as "300" and every
// client read it through coercion — which mostly works (`"300" > 0` is true)
// and silently does not for `=== 0`. The header's "Nothing owed on your reading
// tab." branch is exactly that comparison, so a reader with a clear tab was
// told it settles from their card once it reaches its threshold.
//
// It typechecks, it lints, it builds, and every mocked test of the route hands
// back whatever number its author typed. Only driving it found it, so this pins
// the coercion at the edge where the fix is.
// =============================================================================

const MY_ACCOUNT = path.resolve(__dirname, "..", "..", "gateway/src/routes/my-account.ts");

describe("the tab's figures cross the wire as numbers", () => {
  const route = readFileSync(MY_ACCOUNT, "utf8");

  it("coerces both bigint columns in the route", () => {
    expect(route).toMatch(/tabBalancePence: Number\(/);
    expect(route).toMatch(/refundDuePence: Number\(/);
  });

  it("and the header still compares the tab strictly, which is why it matters", () => {
    // If this comparison ever loosens to `== 0` or `!tabBalancePence` the bug
    // hides again rather than being fixed, and the assertion above stops
    // meaning anything.
    const header = readFileSync(path.join(SRC, BALANCE_HEADER), "utf8");
    expect(header).toMatch(/tabBalancePence === 0/);
  });
});
