import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Skeleton: magic link lifecycle tests
//
// These tests mock pool.query to isolate the pure logic of requestMagicLink
// and verifyMagicLink from the database. Key properties to verify:
//   - Token is 32 bytes of randomness, base64url encoded
//   - Only the SHA-256 hash is stored, never the raw token
//   - verifyMagicLink rejects expired, already-used, and unknown tokens
//   - Single-use: verification marks the link as used
// ---------------------------------------------------------------------------

const mockQuery = vi.fn();
vi.mock("../src/db/client.js", () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

const { requestMagicLink, verifyMagicLink, cleanupExpiredLinks } =
  await import("../src/auth/magic-links.js");

beforeEach(() => {
  mockQuery.mockReset();
});

describe("requestMagicLink", () => {
  it("returns null when no account exists for the email", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await requestMagicLink("unknown@example.com");
    expect(result).toBeNull();
  });

  it("returns a token and stores only its SHA-256 hash", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "acct-1" }] }) // account lookup
      .mockResolvedValueOnce({ rows: [] }); // INSERT magic_links

    const result = await requestMagicLink("user@example.com");
    expect(result).not.toBeNull();
    expect(result!.token).toBeTruthy();
    expect(result!.accountId).toBe("acct-1");
    expect(result!.expiresAt).toBeInstanceOf(Date);

    // Verify the INSERT used the hash, not the raw token
    const insertCall = mockQuery.mock.calls[1];
    const storedHash = insertCall[1][1] as string;
    const expectedHash = createHash("sha256")
      .update(result!.token)
      .digest("hex");
    expect(storedHash).toBe(expectedHash);
    expect(storedHash).not.toBe(result!.token);
  });

  it("normalises email to lowercase", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "acct-1" }] })
      .mockResolvedValueOnce({ rows: [] });

    await requestMagicLink("  User@Example.COM  ");
    const lookupCall = mockQuery.mock.calls[0];
    expect(lookupCall[1][0]).toBe("user@example.com");
  });
});

describe("verifyMagicLink", () => {
  it("returns account ID for a valid unused token", async () => {
    // Single atomic UPDATE … WHERE used_at IS NULL … RETURNING account_id.
    mockQuery.mockResolvedValueOnce({ rows: [{ account_id: "acct-1" }] });

    const result = await verifyMagicLink("valid-token");
    expect(result).toBe("acct-1");
  });

  it("returns null when token not found (expired or invalid)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await verifyMagicLink("bad-token");
    expect(result).toBeNull();
  });

  it("claims the link atomically (single UPDATE … RETURNING)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ account_id: "acct-1" }] });

    await verifyMagicLink("valid-token");
    // One statement, and it is the atomic claim keyed by the token hash — no
    // separate SELECT that a concurrent verify could race (M10).
    expect(mockQuery.mock.calls).toHaveLength(1);
    const updateCall = mockQuery.mock.calls[0];
    expect(updateCall[0]).toContain("UPDATE magic_links SET used_at");
    expect(updateCall[0]).toContain("used_at IS NULL");
    expect(updateCall[0]).toContain("RETURNING account_id");
    const expectedHash = createHash("sha256")
      .update("valid-token")
      .digest("hex");
    expect(updateCall[1][0]).toBe(expectedHash);
  });
});

describe("cleanupExpiredLinks", () => {
  it("returns the number of deleted rows", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 5 });
    const count = await cleanupExpiredLinks();
    expect(count).toBe(5);
  });

  it("returns 0 when nothing to clean", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    const count = await cleanupExpiredLinks();
    expect(count).toBe(0);
  });
});
