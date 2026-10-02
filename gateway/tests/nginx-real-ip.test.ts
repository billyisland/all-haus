import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// =============================================================================
// req.ip IS THE VISITOR, AND ONLY CLOUDFLARE MAY SAY WHO THAT IS
// (MODERNHAUS-ADR §R2.10.2; measured on prod 2026-09-30).
//
// Behind Cloudflare, $remote_addr was an edge address, and `trustProxy: 1`
// made it req.ip — so every per-IP rate-limit bucket was shared by everyone
// behind one Cloudflare location. nginx now takes CF-Connecting-IP, trusted
// only from Cloudflare's published ranges. The danger in this block is
// WIDENING it: a trusted range that is not Cloudflare's lets any client from
// it name its own address, and so its own rate-limit bucket. So every
// `set_real_ip_from` must sit inside a Cloudflare range, and the header must be
// the one Cloudflare sets.
// =============================================================================

const CONF = readFileSync(path.resolve(__dirname, "..", "..", "nginx.conf"), "utf8");

// https://www.cloudflare.com/ips-v4 and /ips-v6, fetched 2026-09-30.
const CLOUDFLARE = new Set([
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
  "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
]);

const code = CONF.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
const trusted = [...code.matchAll(/^\s*set_real_ip_from\s+(\S+);/gm)].map((m) => m[1]);

describe("nginx's real-IP block", () => {
  it("trusts Cloudflare's ranges, all of them, and nothing else", () => {
    expect(trusted.length).toBeGreaterThan(0);
    expect([...trusted].sort()).toEqual([...CLOUDFLARE].sort());
  });

  it("reads the header Cloudflare sets, once, at the http level", () => {
    const headers = [...code.matchAll(/^\s*real_ip_header\s+(\S+);/gm)].map((m) => m[1]);
    expect(headers).toEqual(["CF-Connecting-IP"]);
    // Before the first server block, so both servers (and every location) get it.
    expect(code.indexOf("real_ip_header")).toBeLessThan(code.indexOf("server {"));
  });

  it("does not recurse through X-Forwarded-For, which a client can write", () => {
    expect(code).not.toMatch(/^\s*real_ip_recursive\s+on/m);
  });
});
