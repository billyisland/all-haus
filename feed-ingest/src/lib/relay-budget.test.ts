import { describe, it, expect, beforeEach } from "vitest";
import {
  RELAY_DROP_MS,
  RELAY_FAILURES_TO_DROP,
  recordRelayFailure,
  recordRelaySuccess,
  relayOnCooldown,
  resetRelayBudgets,
} from "./relay-budget.js";

// A relay's budget is the RELAY's, shared across sources, and a drop is a
// cooldown rather than a verdict (CA-C3). See the module header for the two
// fixes this exists instead of.

const R = "wss://relay.example";

beforeEach(() => resetRelayBudgets());

describe("relay budget", () => {
  it("an unknown relay is tried", () => {
    expect(relayOnCooldown(R)).toBe(false);
  });

  it("fewer failures than the threshold do not drop it", () => {
    for (let i = 1; i < RELAY_FAILURES_TO_DROP; i++) {
      expect(recordRelayFailure(R, 1000)).toBe(false);
    }
    expect(relayOnCooldown(R, 1000)).toBe(false);
  });

  it("the threshold-th failure drops it for the cooldown, and the cooldown ends", () => {
    for (let i = 1; i < RELAY_FAILURES_TO_DROP; i++) recordRelayFailure(R, 1000);
    expect(recordRelayFailure(R, 1000)).toBe(true);
    expect(relayOnCooldown(R, 1000)).toBe(true);
    expect(relayOnCooldown(R, 1000 + RELAY_DROP_MS - 1)).toBe(true);
    expect(relayOnCooldown(R, 1000 + RELAY_DROP_MS)).toBe(false);
  });

  it("after the cooldown, one more failure re-drops it — the relay is not trusted three times over again", () => {
    for (let i = 0; i < RELAY_FAILURES_TO_DROP; i++) recordRelayFailure(R, 1000);
    expect(relayOnCooldown(R, 1000 + RELAY_DROP_MS)).toBe(false);
    expect(recordRelayFailure(R, 1000 + RELAY_DROP_MS)).toBe(true);
  });

  it("a success anywhere clears the count", () => {
    for (let i = 1; i < RELAY_FAILURES_TO_DROP; i++) recordRelayFailure(R, 1000);
    recordRelaySuccess(R);
    for (let i = 1; i < RELAY_FAILURES_TO_DROP; i++) {
      expect(recordRelayFailure(R, 1000)).toBe(false);
    }
  });

  it("budgets are per relay", () => {
    for (let i = 0; i < RELAY_FAILURES_TO_DROP; i++) recordRelayFailure(R, 1000);
    expect(relayOnCooldown("wss://other.example", 1000)).toBe(false);
  });
});
