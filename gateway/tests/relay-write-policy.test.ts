import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// =============================================================================
// The relay accepts writes from the platform only (MIRROR-AUDIT §3, S16).
//
// strfry sits behind nginx at `wss://all.haus/relay` and had no `writePolicy`
// at all, so its default — accept everything — applied and anyone on the
// internet could publish any event into the relay that holds every article this
// platform has published. The 2026-07-16 loopback port bind did not touch it:
// that closed the raw port, and the nginx route was never the raw port.
//
// WHY THIS FILE EXISTS AT ALL. The policy is a THREE-PART capability, and any
// one part alone is silently useless — the same shape as the embed allowlist ⟂
// `frame-src` pair, and pinned here for the same reason a comment cannot fail:
//
//   1. `relay/write-policy.py` decides.
//   2. `relay/strfry.conf` must NAME it, and must set `realIpHeader` — without
//      that, every connection arriving through nginx reports NGINX's own
//      container address, which is private, and the policy accepts the whole
//      internet while looking like it is working.
//   3. `docker-compose.yml` must MOUNT it at the path strfry.conf names.
//
// Break any of the three and the relay is open-write again with no error
// anywhere, which is precisely the state this closed.
//
// The behavioural cases drive the REAL script the container runs, as a
// subprocess over its real JSONL protocol, with input captured from a live
// strfry 1.1.0 (`{"type":"new","event":{…},"sourceType":"IP4","sourceInfo":…}`).
// A reimplementation of the rule in TypeScript would agree with itself.
// =============================================================================

const REPO = resolve(__dirname, "../..");
const POLICY = resolve(REPO, "relay/write-policy.py");
const CONF = readFileSync(resolve(REPO, "relay/strfry.conf"), "utf8");
const COMPOSE = readFileSync(resolve(REPO, "docker-compose.yml"), "utf8");

const EVENT_ID = "a".repeat(64);

/** Feed the real script one request and read its verdict. */
function decide(req: Record<string, unknown>): { action?: string; msg?: string } {
  const out = execFileSync("python3", [POLICY], {
    input: JSON.stringify(req) + "\n",
    encoding: "utf8",
  });
  const line = out.trim().split("\n").filter(Boolean).pop();
  return line ? (JSON.parse(line) as { action?: string; msg?: string }) : {};
}

const fromIp = (ip: string) => ({
  type: "new",
  sourceType: "IP4",
  sourceInfo: ip,
  receivedAt: 1789051227,
  event: { id: EVENT_ID, pubkey: "b".repeat(64), kind: 1, tags: [], content: "" },
});

describe("strfry write policy — the decision", () => {
  it("accepts a write from the compose network (the relay-outbox worker's path)", () => {
    // Every event the platform publishes goes to `ws://strfry:7777` directly,
    // never through nginx — `PLATFORM_RELAY_WS_URL` in docker-compose.yml. If
    // this case fails, publishing is dead.
    expect(decide(fromIp("172.18.0.7")).action).toBe("accept");
    expect(decide(fromIp("10.1.2.3")).action).toBe("accept");
    expect(decide(fromIp("127.0.0.1")).action).toBe("accept");
  });

  it("refuses a write from the public internet", () => {
    const v = decide(fromIp("8.8.8.8"));
    expect(v.action).toBe("reject");
    // NIP-01's terminal prefix: our own outbound classifier reads `blocked:` as
    // a deterministic refusal, which is what this is. Retrying it would burn a
    // relay_outbox row's whole budget against a decision that will not change.
    expect(v.msg).toMatch(/^blocked:/);
  });

  it("refuses an address in a documentation range", () => {
    // The case that caught the first draft. `ipaddress.is_private` counts RFC
    // 5737 (203.0.113.0/24 and friends) as private, so a policy written on that
    // predicate accepted a stand-in for a public client and was proved WORKING
    // by a probe that had in fact been accepted. The explicit network list is
    // what makes the rule say what it means.
    expect(decide(fromIp("203.0.113.7")).action).toBe("reject");
    expect(decide(fromIp("198.51.100.4")).action).toBe("reject");
    expect(decide(fromIp("100.64.0.1")).action).toBe("reject"); // CGNAT
  });

  it("refuses when it cannot parse the source at all — fail closed", () => {
    expect(decide({ ...fromIp("8.8.8.8"), sourceInfo: "not-an-address" }).action)
      .toBe("reject");
    expect(decide({ ...fromIp("8.8.8.8"), sourceInfo: null }).action).toBe("reject");
  });

  it("lets the operator's own import/stream/sync through", () => {
    // `strfry import` is the recovery path that recovered 22 abandoned outbox
    // rows in 2026-07-16. It reports a non-IP sourceType and is listed by name
    // rather than falling through some default.
    for (const sourceType of ["Import", "Stream", "Sync"]) {
      expect(decide({ ...fromIp("8.8.8.8"), sourceType }).action).toBe("accept");
    }
  });

  it("answers every request it is given, so a stream of them cannot desync", () => {
    const out = execFileSync("python3", [POLICY], {
      input:
        [fromIp("8.8.8.8"), fromIp("172.18.0.7"), fromIp("1.1.1.1")]
          .map((r) => JSON.stringify(r))
          .join("\n") + "\n",
      encoding: "utf8",
    });
    const lines = out.trim().split("\n").filter(Boolean);
    expect(lines.map((l) => JSON.parse(l).action)).toEqual([
      "reject",
      "accept",
      "reject",
    ]);
  });
});

describe("strfry write policy — the wiring the decision depends on", () => {
  it("strfry.conf names the plugin", () => {
    expect(CONF).toMatch(/writePolicy\s*\{[^}]*plugin\s*=\s*"([^"]+)"/s);
  });

  it("strfry.conf sets realIpHeader, without which the policy accepts everyone", () => {
    const m = CONF.match(/^\s*realIpHeader\s*=\s*"([^"]*)"/m);
    expect(m).not.toBeNull();
    expect(m![1]).not.toBe("");
  });

  it("docker-compose mounts the plugin at the path strfry.conf names", () => {
    const plugin = CONF.match(/writePolicy\s*\{[^}]*plugin\s*=\s*"([^"]+)"/s)![1];
    // The container path on the right of the bind mount must be exactly what
    // the config asks strfry to exec. A rename on either side is silent.
    expect(COMPOSE).toContain(`./relay/write-policy.py:${plugin}:ro`);
  });

  it("the relay image is pinned, not :latest", () => {
    const m = COMPOSE.match(/^\s*image:\s*(dockurr\/strfry\S+)/m);
    expect(m).not.toBeNull();
    expect(m![1]).not.toContain(":latest");
    expect(m![1]).toContain("@sha256:");
  });
});
