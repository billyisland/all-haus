import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// =============================================================================
// Every account-keyed table is either exported or withheld BY NAME (§0z 16)
//
// Rule (5) of the data-subject-bundle rule says what is withheld is withheld
// on purpose and named. Until 2026-09-18 the bundle carried eleven families
// and named none of the ~thirty other tables with a foreign key to `accounts`
// that it left out. This test reads schema.sql's OWN foreign-key list and
// holds the route's two lists against it: a table in neither is a table
// somebody added and nobody decided about.
//
// Reads the schema rather than the live DB: the question is about what the
// platform holds by construction, and the answer must not depend on which
// tables happen to have rows in a test database.
// =============================================================================

process.env.KEY_SERVICE_URL ??= "http://key-service.test";
process.env.INTERNAL_SECRET ??= "test-internal";

const { EXPORTED_TABLES, WITHHELD } = await import("../src/routes/export.js");

function accountKeyedTables(): string[] {
  const schema = readFileSync(join(__dirname, "../../schema.sql"), "utf8");
  const out = new Set<string>();
  // `ALTER TABLE ONLY public.<t>\n    ADD CONSTRAINT … REFERENCES public.accounts(id)`
  const re = /ALTER TABLE ONLY public\.([a-z_]+)\n\s+ADD CONSTRAINT [a-z_]+ FOREIGN KEY \([a-z_]+\) REFERENCES public\.accounts\(id\)/g;
  for (const m of schema.matchAll(re)) out.add(m[1]);
  // Assert we FOUND the list — a reworded dump would otherwise make this pass
  // by testing nothing.
  expect(out.size).toBeGreaterThan(40);
  return [...out].sort();
}

describe("the export names every account-keyed table, in one list or the other", () => {
  it("leaves no table undecided", () => {
    const exported = new Set<string>(EXPORTED_TABLES);
    const withheld = new Set(WITHHELD.map((w) => w.table));
    const undecided = accountKeyedTables().filter((t) => !exported.has(t) && !withheld.has(t));
    expect(undecided, "account-keyed tables the export neither carries nor names").toEqual([]);
  });

  it("puts no table in both lists", () => {
    const withheld = new Set(WITHHELD.map((w) => w.table));
    expect(EXPORTED_TABLES.filter((t) => withheld.has(t))).toEqual([]);
  });

  it("every withheld entry says why, in a sentence", () => {
    for (const w of WITHHELD) expect(w.why.trim().length, w.table).toBeGreaterThan(20);
  });

  it("names only tables that exist", () => {
    const schema = readFileSync(join(__dirname, "../../schema.sql"), "utf8");
    for (const t of [...EXPORTED_TABLES, ...WITHHELD.map((w) => w.table)]) {
      expect(schema, `${t} is not a table in schema.sql`).toContain(`CREATE TABLE public.${t} (`);
    }
  });
});
