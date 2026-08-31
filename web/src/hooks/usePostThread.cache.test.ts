import { describe, it, expect, beforeEach } from "vitest";
import { readCache, writeCache, __resetThreadCache } from "./usePostThread";
import type { PostThreadResponse } from "../lib/api/post";

// =============================================================================
// THREAD-HYDRATION-LATENCY-ADR D2 — cache hygiene. A partial (`hydrating: true`)
// thread response must NEVER be served from the module cache: caching it for the
// 60 s TTL is what pinned every re-expand to an empty thread until the TTL
// expired. Only settled results (`hydrating` absent/false) are cacheable.
// =============================================================================

function res(over: Partial<PostThreadResponse> = {}): PostThreadResponse {
  return {
    focalId: "focal",
    posts: [],
    repostEdges: [],
    totalDescendants: 0,
    ...over,
  };
}

describe("usePostThread cache hygiene (D2)", () => {
  beforeEach(() => __resetThreadCache());

  it("round-trips a settled response", () => {
    const settled = res({ focalId: "x", totalDescendants: 3 });
    writeCache("x", settled);
    expect(readCache("x")).toBe(settled);
  });

  it("treats hydrating:false as settled (cacheable)", () => {
    const done = res({ focalId: "y", hydrating: false });
    writeCache("y", done);
    expect(readCache("y")).toBe(done);
  });

  it("refuses to cache a hydrating:true partial", () => {
    writeCache("z", res({ focalId: "z", hydrating: true }));
    // Nothing to serve on re-expand → the caller re-fetches instead of stalling.
    expect(readCache("z")).toBeUndefined();
  });

  it("a partial never shadows a later settled result", () => {
    writeCache("w", res({ focalId: "w", hydrating: true }));
    expect(readCache("w")).toBeUndefined();
    const settled = res({ focalId: "w", totalDescendants: 2 });
    writeCache("w", settled);
    expect(readCache("w")).toBe(settled);
  });
});
