// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import path from "node:path";

// =============================================================================
// READER-WRITER-SPLIT-ADR §6: what a READER meets wherever writing would be.
//
// One body (`WriterAccessPanel`) and one press (`POST /writer-applications`).
// Driven here for the three answers the press can get — applied, already a
// writer (a grant landed while the pane was open), and a fault — and pinned
// structurally at every surface that must render it for a reader rather than
// a writing control the gateway would refuse.
// =============================================================================

const applyToWrite = vi.fn();
vi.mock("../src/lib/api/auth", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    auth: { ...(real.auth as object), applyToWrite: () => applyToWrite() },
  };
});

const { WriterAccessPanel } = await import("../src/components/writer/WriterAccessPanel");
const { useAuth } = await import("../src/stores/auth");
const { ApiError } = await import("../src/lib/api/client");

let root: Root;
let host: HTMLDivElement;
beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  applyToWrite.mockReset();
  useAuth.setState({
    user: { id: "u1", canWrite: false, writerApplication: null } as never,
    loading: false,
  });
  host = document.createElement("div");
  root = createRoot(host);
  act(() => root.render(<WriterAccessPanel />));
});

const button = () => host.querySelector("button");

describe("WriterAccessPanel", () => {
  it("offers the one press, and after it says when, and offers it no more", async () => {
    applyToWrite.mockResolvedValue({ appliedAt: "2026-09-30T12:00:00Z" });
    expect(button()?.textContent).toBe("Apply to write");
    await act(async () => button()!.click());
    expect(applyToWrite).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Application sent on 30 September 2026.");
    expect(button()).toBeNull();
    expect(useAuth.getState().user?.writerApplication).toEqual({ appliedAt: "2026-09-30T12:00:00Z" });
  });

  it("already a writer: the session is re-read, not an error shown", async () => {
    applyToWrite.mockRejectedValue(new ApiError(409, { error: "already_writer" }));
    const fetchMe = vi.fn().mockResolvedValue(undefined);
    useAuth.setState({ fetchMe } as never);
    await act(async () => button()!.click());
    expect(fetchMe).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".text-crimson")).toBeNull();
  });

  it("a fault says the application was not sent", async () => {
    applyToWrite.mockRejectedValue(new TypeError("Failed to fetch"));
    await act(async () => button()!.click());
    expect(host.textContent).toContain("Your application was not sent. Try again.");
    expect(button()?.textContent).toBe("Apply to write");
  });
});

describe("every writer surface renders it for a reader", () => {
  const SRC = path.resolve(__dirname, "../src");
  const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

  it.each([
    ["components/workspace/DashboardOverlay.tsx", /if \(!canWrite\) \{[\s\S]*?<WriterAccessPanel \/>/],
    ["components/workspace/EditorOverlay.tsx", /if \(!canWrite\) \{[\s\S]*?<WriterAccessPanel \/>/],
    ["app/write/page.tsx", /if \(!user\.canWrite\) return <WriterAccessPage \/>/],
    ["app/traffology/TraffologyShell.tsx", /if \(isReader\) return <WriterAccessPage \/>/],
  ])("%s", (rel, gate) => {
    expect(read(rel)).toMatch(gate);
  });

  it("each overlay reads canWrite as `=== true`, so an absent field is a reader", () => {
    for (const rel of ["components/workspace/DashboardOverlay.tsx", "components/workspace/EditorOverlay.tsx"]) {
      expect(read(rel)).toContain("useAuth((s) => s.user?.canWrite === true)");
    }
  });

  it("the ∀ menu's Dashboard row is the Apply row for a reader", () => {
    const src = read("components/workspace/ForallMenu.tsx");
    expect(src).toMatch(/label: canWrite\s*\?\s*"Dashboard"\s*:\s*writerApplied\s*\?\s*WRITER_MENU_APPLIED\s*:\s*WRITER_MENU_APPLY/);
    expect(src).toContain("useAuth((s) => s.user?.canWrite === true)");
  });

  it("Settings › Payment shows Connect to a writer only", () => {
    expect(read("components/account/PaymentSection.tsx")).toMatch(/\{user\.canWrite && \(\s*<div>/);
  });
});
