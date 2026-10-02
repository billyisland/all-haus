import { describe, it, expect } from "vitest";
import { createFeedLoads, loadPageOne } from "./feedLoads";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("page-one loads (§VI.5)", () => {
  it("an older read landing after a newer one started is DISCARDED", async () => {
    const loads = createFeedLoads();
    const firstPage = deferred<string>();
    const secondPage = deferred<string>();
    const applied: string[] = [];
    const apply = (p: string) => (applied.push(p), p);

    // The first read starts; a second starts while it is in flight; the
    // first's answer lands first.
    const first = loadPageOne(loads, "f", () => firstPage.promise, apply);
    const second = loadPageOne(loads, "f", () => secondPage.promise, apply);
    firstPage.resolve("first");
    expect(await first).toEqual({ status: "superseded" });
    expect(applied).toEqual([]);
    secondPage.resolve("second");
    expect(await second).toEqual({ status: "applied", value: "second" });
    expect(applied).toEqual(["second"]);
  });

  it("a failure of a superseded read is not reported as one", async () => {
    const loads = createFeedLoads();
    const a = deferred<string>();
    const first = loadPageOne(loads, "f", () => a.promise, (p) => p);
    const second = loadPageOne(loads, "f", async () => "ok", (p) => p);
    a.reject(new Error("boom"));
    expect(await first).toEqual({ status: "superseded" });
    expect(await second).toEqual({ status: "applied", value: "ok" });
    const lone = await loadPageOne(loads, "f", async () => {
      throw new Error("down");
    }, (p) => p);
    expect(lone.status).toBe("failed");
  });

  it("load-more's token is the current one, and a claim moves it", () => {
    const loads = createFeedLoads();
    expect(loads.current("f")).toBe(0);
    const g = loads.claim("f");
    expect(loads.isCurrent("f", g)).toBe(true);
    loads.claim("f");
    expect(loads.isCurrent("f", g)).toBe(false);
  });
});

describe("the host goes through it", () => {
  it("WorkspaceView's page-one reads are `loadPageOne`, and nothing reads ahead", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(__dirname, "../../components/workspace/WorkspaceView.tsx"),
      "utf8",
    );
    expect(src).toMatch(/await loadPageOne\(\s*feedLoads,/);
    expect(src).not.toMatch(/approach/i);
    expect(src).not.toMatch(/feedGenRef/);
  });
});
