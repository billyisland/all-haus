import { describe, it, expect, vi } from "vitest";

// =============================================================================
// A RE-ENCRYPTED BODY RESTAMPS ITS ALGORITHM (CA-A5, 2026-09-29).
//
// An edit reuses the article's vault key row and re-encrypts the body with
// XChaCha — and wrote only `ciphertext`. A row written before XChaCha still
// said 'aes-256-gcm', and issueKey / decryptForAuthor branch on that column,
// so editing a legacy piece made it undecryptable. Prod had no such row on
// 2026-09-29 (4 of 4 xchacha), which is why this is hygiene; the column's
// default is flipped in migration 261.
//
// MUTATION: drop `algorithm = $2` from the UPDATE → this goes red.
// =============================================================================

const issued: Array<{ sql: string; params: unknown[] }> = [];

vi.mock("@platform-pub/shared/db/client.js", () => {
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (sql.includes("SELECT id, content_key_enc FROM vault_keys")) {
        return { rows: [{ id: "vk-legacy", content_key_enc: "enc" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  return {
    pool: client,
    withTransaction: vi.fn(async (fn: (c: typeof client) => unknown) => fn(client)),
  };
});
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/lib/kms.js", () => ({
  generateContentKey: vi.fn(() => Buffer.alloc(32)),
  encryptContentKey: vi.fn(() => "enc"),
  decryptContentKey: vi.fn(() => Buffer.alloc(32)),
}));
vi.mock("../src/lib/crypto.js", () => ({
  encryptArticleBodyXChaCha: vi.fn(() => "ciphertext"),
  decryptArticleBodyXChaCha: vi.fn(),
  decryptArticleBody: vi.fn(),
}));

const { vaultService } = await import("../src/services/vault.js");

describe("publishArticle on an existing key row", () => {
  it("writes the algorithm beside the ciphertext it just produced", async () => {
    const res = await vaultService.publishArticle({
      articleId: "a1",
      nostrArticleEventId: "e".repeat(64),
      paywallBody: "the paid half",
      pricePence: 100,
      gatePositionPct: 50,
      nostrDTag: "d",
    });

    const write = issued.find((q) => q.sql.includes("SET ciphertext"));
    expect(write?.sql).toContain("algorithm = $2");
    expect(write?.params).toEqual(["ciphertext", "xchacha20poly1305", "vk-legacy"]);
    expect(res.algorithm).toBe("xchacha20poly1305");
  });
});
