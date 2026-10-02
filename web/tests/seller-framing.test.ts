import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// =============================================================================
// THE WRITER IS THE SELLER, AND THE COPY HAS TO SAY SO (Reader Terms 1.1;
// compliance audit 1.2/1.5/1.8/7.2, the BLOCKING finding).
//
// "When you unlock a piece of paid content, your contract for that content is
// with the Writer, not with us. The Writer is the seller. We conclude the sale
// on the Writer's behalf, as the Writer's disclosed agent."
//
// No surface said that, and several said the opposite: the About page opened
// "all.haus is a reading platform that PAYS the people you read" (us as payer)
// and described "managing your payments, taking an 8% cut" (us as the Writer's
// payment manager rather than their agent charging a fee); the paywall gate
// promised to "bill you"; the card-declined banner said "we could not take
// payment", as if the debt were ours. Nothing at the purchase point, on the
// statement, in any email or in Stripe metadata said the Reader was buying from
// the Writer. Why the wording is load-bearing: docs/adr/LEGAL-BRAKES.md.
//
// And the free allowance was called CREDIT everywhere — a word that means a
// balance a reader holds, which is the one thing Reader Terms 4.2 says the tab
// is not. It is an allowance: a gift, charged to nobody, earning nobody.
//
// THE SCAN IS TWO-PASS, for the reason `ellipsis-house-style.test.ts` learned
// the hard way: copy is not only a string literal, and JSX text between two tags
// is invisible to a literal-only grep. Comments are cut from the residue, since
// several of the rewritten files now explain the ban in the words it bans —
// which is also why each banned phrase is paired with an assertion that its
// REPLACEMENT is really present. "No banned phrase survives" is equally true of
// a tree the scan failed to find.
// =============================================================================

const ROOT = path.resolve(__dirname, "..", "src");

const STRING_RE = /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`)/g;

// The published legal texts are excluded, and only they. They are the document
// the rest of the site has to agree with: Reader Terms 7.1 uses the word
// "credit" deliberately, of the statutory kind of thing an allowance is, and a
// legal text is never rewritten to satisfy a grep.
const EXEMPT = [path.join(ROOT, "content", "legal")];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (EXEMPT.some((e) => full.startsWith(e))) continue;
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every user-visible line of copy in the tree, as `file:line — text`. */
function copyLines(files: string[]): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      const where = `${path.relative(ROOT, file)}:${i + 1}`;
      for (const m of line.matchAll(STRING_RE)) out.push({ where, text: m[0] });
      const residue = line.replace(STRING_RE, '""').split("//")[0].split("/*")[0];
      out.push({ where, text: residue });
    });
  }
  return out;
}

const BANNED: { phrase: RegExp; why: string }[] = [
  {
    phrase: /pays the people you read/i,
    why: "names all.haus as the payer; the Reader buys from the Writer (1.1)",
  },
  {
    phrase: /8% cut/i,
    why: "a cut of somebody else's money is not an agent's fee (1.2)",
  },
  {
    phrase: /bill you/i,
    why: "names all.haus as the biller of its own debt (1.2)",
  },
  {
    phrase: /reading credit/i,
    why: "the free allowance is an allowance, not a credit balance (4.2, A2)",
  },
  {
    phrase: /free credit/i,
    why: "as above — 'credit' offers a balance the tab is not",
  },
  {
    phrase: /take payment with the card/i,
    why: "collection is on the Writer's behalf, not for a debt of ours",
  },
  {
    phrase: /we could not take (the final )?payment/i,
    why: "as above — the card declined, the debt is to the writers",
  },
];

// A GATEWAY SENTENCE THE WEB SHOWS IS WEB COPY. Refusals travel as `message`
// (or, on the subscribe route, a sentence in `error`) and the web renders them
// through `failureSentence` / `apiErrorMessage` — so the settle route's and the
// account deletion's declined-card sentences said "we could not take payment"
// on the full site for as long as the scan above looked at web source alone
// (MODERNHAUS-ADR §E5.3/§E6.3). This pass reads only the values of those two
// keys, never a log line, which is not copy anybody is shown.
const GATEWAY = path.resolve(__dirname, "..", "..", "gateway", "src");
const WIRE_SENTENCE_RE =
  /\b(?:message|error):\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;

function gatewayFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...gatewayFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Every `message:` / `error:` string the gateway sends, as `file:line — text`. */
function wireSentences(files: string[]): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(WIRE_SENTENCE_RE)) {
      const line = src.slice(0, m.index).split("\n").length;
      out.push({ where: `gateway/${path.relative(GATEWAY, file)}:${line}`, text: m[1] });
    }
  }
  return out;
}

describe("no surface contradicts the agency model", () => {
  const files = sourceFiles(ROOT);

  it("finds the tree it is meant to be scanning", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("carries none of the phrases that name all.haus as the seller or payer", () => {
    const lines = copyLines(files);
    const hits: string[] = [];
    for (const { where, text } of lines) {
      for (const { phrase, why } of BANNED) {
        if (phrase.test(text)) hits.push(`${where} — ${text.trim()}  [${why}]`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("and neither does any sentence the gateway sends for the web to show", () => {
    const sentences = wireSentences(gatewayFiles(GATEWAY));
    // It found the wire, not an empty directory or a regex that matches nothing.
    expect(sentences.length).toBeGreaterThan(200);
    const hits: string[] = [];
    for (const { where, text } of sentences) {
      for (const { phrase, why } of BANNED) {
        if (phrase.test(text)) hits.push(`${where} — ${text}  [${why}]`);
      }
    }
    expect(hits).toEqual([]);
    // The two routes that had the banned sentence say the replacement.
    const settle = readFileSync(path.join(GATEWAY, "routes/my-account.ts"), "utf8");
    expect(settle).toContain("The card on file was declined. Add a working card to settle your tab.");
    const auth = readFileSync(path.join(GATEWAY, "routes/auth.ts"), "utf8");
    expect(auth).toContain("The card on file was declined, so your reading tab is still open.");
  });

  it("says what it says INSTEAD — the replacement is really present", () => {
    // A scan finding nothing is also what a deleted surface looks like. These
    // are the sentences the rewrite put in, each at the surface that had the
    // banned one.
    // About's words live in `content/about.ts`, which both registers render
    // (the full site's AboutContent and modernhaus's About).
    const about = readFileSync(path.join(ROOT, "content/about.ts"), "utf8");
    expect(about).toContain("where you buy what you read");
    expect(about).toContain("sells it on your behalf, as your agent");

    // The gate's sentences live in content/paywall.ts, which both registers read.
    const gate = readFileSync(path.join(ROOT, "content/paywall.ts"), "utf8");
    // The purchase point names the Writer.
    expect(gate).toContain("buying this from ${writerName}");

    // The declined-card words live in content/ledger.ts, which both registers read.
    const declined = readFileSync(path.join(ROOT, "content/ledger.ts"), "utf8");
    expect(declined).toContain("what you owe the writers");

    const modal = readFileSync(path.join(ROOT, "components/ui/AllowanceExhaustedModal.tsx"), "utf8");
    expect(modal).toContain("free reading allowance");
  });

  it("calls the gift an allowance somewhere, not merely nowhere a credit", () => {
    const withAllowance = files.filter((f) =>
      /free (reading )?allowance/i.test(readFileSync(f, "utf8")),
    );
    expect(withAllowance.length).toBeGreaterThan(3);
  });
});
