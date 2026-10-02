import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// =============================================================================
// A MEMBER'S POST ELSEWHERE LINKS TO THEM (CROSS-NETWORK-ROUNDTRIP-ADR D1).
//
// The gateway's mapper names the member who claims an external identity — only
// where they consented to showing it — as `author.memberUsername`, and the
// external byline links there. There is no module path between the workspaces
// and `tsc` is content with a web field the gateway never sends, so both ends
// are pinned by READING the files that own them, each match asserted FOUND.
// (Whether the gateway gates the field on the consent is Postgres's to answer:
// gateway/tests/presence-identity-claim.test.ts.)
// =============================================================================

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("author.memberUsername on the wire", () => {
  it("the gateway's PostAuthor carries it, from the consent-gated column", () => {
    const mapper = read("gateway/src/lib/post-mapper.ts");
    expect(mapper).toMatch(/interface PostAuthor \{[\s\S]*?\bmemberUsername: string \| null;/);
    expect(mapper).toMatch(/memberUsername: row\.xa_member_username \?\? null,/);
    expect(mapper).toMatch(/disclosedClaimantUsernameSql\("xa"\)\} END AS xa_member_username/);
  });

  it("the web type declares it and the external byline links by it", () => {
    const types = read("web/src/lib/post/types.ts");
    expect(types).toMatch(/\bmemberUsername\?: string \| null;/);
    const byline = read("web/src/components/post/PostByline.tsx");
    const external = byline.slice(byline.indexOf("function ExternalByline("));
    expect(external.length).toBeGreaterThan(0);
    expect(external).toMatch(/post\.author\.memberUsername\s*\n?\s*\?\s*`\/\$\{post\.author\.memberUsername\}`/);
  });
});

// A NATIVE BYLINE NAMES ITS AUTHOR FROM THE POST (CA-G7). The mapper fills a
// native author's name and handle from its `accounts` join, so the byline makes
// no `GET /writers/by-pubkey` of its own — it had been, once per distinct
// author, and showing hex until the answer.
describe("a native author's name on the wire", () => {
  it("the gateway fills displayName and handle from the accounts join, both native arms", () => {
    const mapper = read("gateway/src/lib/post-mapper.ts");
    expect(mapper).toMatch(/acc\.display_name AS acc_display_name, acc\.username AS acc_username/);
    expect(mapper).toMatch(/displayName: row\.acc_display_name \?\? null,\s*\n\s*handle: row\.acc_username \?\? null,/);
    expect(mapper).toMatch(/displayName: c\.acc_display_name,\s*\n\s*handle: c\.acc_username,/);
  });

  it("the native byline reads them off the Post and asks nobody", () => {
    const byline = read("web/src/components/post/PostByline.tsx");
    expect(byline).not.toMatch(/useWriterName/);
    const start = byline.indexOf("function NativeByline(");
    const end = byline.indexOf("function ExternalByline(");
    expect(start).toBeGreaterThan(0);
    const native = byline.slice(start, end);
    expect(native).toMatch(/post\.author\.displayName \?\?\s*\n\s*post\.author\.handle \?\?/);
    expect(native).toMatch(/`\/\$\{post\.author\.handle\}`/);
  });
});
