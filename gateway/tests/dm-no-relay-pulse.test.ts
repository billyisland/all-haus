import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// =============================================================================
// A DIRECT MESSAGE PUTS NOTHING ON THE RELAY (walkthrough A8)
//
// `sendMessage` used to finish by signing a kind-14 with the SENDER's key,
// tagged with the conversation's uuid, and enqueueing it to the public relay.
// The body stayed private; the DM graph and the timing of every exchange did
// not — two pubkeys tagging one conversation id are provably talking. Nothing
// read the event. The pin is on the service's SOURCE: it must reach neither
// the signer nor the outbox. It first asserts the file was the one it meant to
// read (the key-custody import it still has), so a moved file fails loudly
// rather than passing on an empty string.
//
// MUTATION CHECK: restore `signEvent` to the key-custody import, or import
// `enqueueRelayPublish`, and a case fails.
// =============================================================================

const source = readFileSync(
  fileURLToPath(new URL("../src/services/messages.ts", import.meta.url)),
  "utf8",
);

describe("messages service — no relay side effect", () => {
  it("reads the service it means to", () => {
    expect(source).toMatch(/from '\.\.\/lib\/key-custody-client\.js'/);
    expect(source).toMatch(/export async function sendMessage\(/);
  });

  it("never signs an event", () => {
    expect(source).not.toMatch(/\bsignEvent\b/);
  });

  it("never enqueues to the relay outbox", () => {
    expect(source).not.toMatch(/enqueueRelayPublish|relay-outbox|conversation_pulse/);
  });
});
