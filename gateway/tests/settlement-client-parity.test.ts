import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SETTLEMENT_OUTCOME_KINDS } from "../src/lib/settlement-client.js";

// =============================================================================
// The gateway's settlement outcomes vs the payment service's — pinned by
// reading the other workspace's SOURCE.
//
// A TYPE IS NOT A CONTRACT. `SettlementOutcome` in gateway/src/lib is a
// hand-written claim about what payment-service sends, and `tsc` will check the
// gateway against that claim forever without ever checking the claim itself —
// the two workspaces share no module path. The admin Reports page shipped a
// whole decorative surface on exactly this: an action vocabulary the gateway's
// zod enum had never accepted, typechecked and built throughout.
//
// So this reads the union out of the file that owns it and diffs the sets. Both
// directions matter and for different reasons: a kind the payment service sends
// and the gateway does not know is a refusal that reaches a reader as an
// "ambiguous" 502; a kind the gateway branches on and the service never sends
// is dead code that looks like coverage.
//
// The grep must FIND something first. A renamed type would otherwise leave this
// test comparing against an empty set and passing while it tested nothing.
// =============================================================================

const SETTLEMENT_SRC = path.resolve(
  __dirname,
  "../../payment-service/src/services/settlement.ts",
);
const PAYMENT_ROUTES_SRC = path.resolve(
  __dirname,
  "../../payment-service/src/routes/payment.ts",
);

/** The `kind: "…"` literals of the SettlementAttempt union, in source order. */
function attemptKindsFromSource(): string[] {
  const src = fs.readFileSync(SETTLEMENT_SRC, "utf8");
  const block = src.match(
    /export type SettlementAttempt =([\s\S]*?);\n/,
  );
  expect(
    block,
    "SettlementAttempt union not found in settlement.ts — the pin is reading the wrong thing",
  ).toBeTruthy();
  return [...block![1].matchAll(/kind:\s*"([a-z_]+)"/g)].map((m) => m[1]);
}

describe("settlement outcomes agree across the two services", () => {
  it("finds a union to compare against at all", () => {
    expect(attemptKindsFromSource().length).toBeGreaterThan(3);
  });

  it("every outcome the payment service can send, the gateway knows", () => {
    const sent = attemptKindsFromSource();
    const known = new Set<string>(SETTLEMENT_OUTCOME_KINDS);
    expect(sent.filter((k) => !known.has(k))).toEqual([]);
  });

  it("every outcome the gateway branches on, the payment service can send — bar `ambiguous`", () => {
    // `ambiguous` is the gateway's own: it stands for a transport failure, a
    // non-2xx, a body it could not parse and an unknown kind, none of which the
    // payment service has a word for. It is the one legitimate extra.
    const sent = new Set(attemptKindsFromSource());
    const extra = SETTLEMENT_OUTCOME_KINDS.filter((k) => !sent.has(k));
    expect(extra).toEqual(["ambiguous"]);
  });

  it("the triggers the gateway asks for are the ones the route accepts", () => {
    // The gateway sends `reader_requested` / `account_closure`; the route's zod
    // enum is what decides whether that is a settlement or a 400. Read the enum
    // rather than trusting the two spellings to have stayed in step.
    const src = fs.readFileSync(PAYMENT_ROUTES_SRC, "utf8");
    const enumMatch = src.match(/trigger:\s*z\.enum\(\[([^\]]+)\]\)/);
    expect(
      enumMatch,
      "the settle-now trigger enum was not found — the pin is reading the wrong thing",
    ).toBeTruthy();
    const accepted = [...enumMatch![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(accepted.sort()).toEqual(["account_closure", "reader_requested"]);
  });

  it("the accepted triggers are all legal values of tab_settlements.trigger_type", () => {
    // The column's CHECK is what a reserve INSERT is actually validated against
    // (migration 205), and a trigger the route accepts but the constraint
    // refuses fails at the INSERT with the reader's money untouched and their
    // account undeleted — a 23514 in a log, and a member who cannot leave.
    const schema = fs.readFileSync(
      path.resolve(__dirname, "../../schema.sql"),
      "utf8",
    );
    const check = schema.match(
      /CONSTRAINT tab_settlements_trigger_type_check CHECK \(\(trigger_type = ANY \(ARRAY\[([^\]]+)\]\)\)\)/,
    );
    expect(
      check,
      "the trigger_type CHECK was not found in schema.sql — the pin is reading the wrong thing",
    ).toBeTruthy();
    const legal = [...check![1].matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
    for (const trigger of ["reader_requested", "account_closure", "tab_ceiling"]) {
      expect(legal, `${trigger} must be a legal trigger_type`).toContain(trigger);
    }
  });
});
