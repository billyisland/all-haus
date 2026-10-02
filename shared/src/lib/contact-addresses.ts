// =============================================================================
// THE HOUSE MAILBOXES — one spelling, wherever a member is told how to reach us.
//
// The published Reader Terms and Writer Agreement send members to these
// addresses and promise a reply (Reader 8.3 for refunds, 14.1 for complaints
// within five working days). An address a document promises is a commitment,
// and a second spelling of it in a component or an email is a commitment made
// to a mailbox nobody reads.
//
// Until 2026-09-17 not one of these appeared anywhere in shipped code: the only
// place any of them existed was inside the two legal `.md` files, where nothing
// could check them. This module is the register, and
// `web/tests/legal-contact-addresses.test.ts` pins the published texts against
// it — the texts keep their own literal wording (a legal document says exactly
// what it says and is never templated), so the check is that the two agree, not
// that one is built from the other.
//
// **THE OPERATOR HALF IS THAT EACH BOX ACTUALLY RECEIVES.** A constant here
// proves only that we all spell it the same way. `DEPLOYMENT.md` carries the
// row: every address below has to be deliverable before the pages that name it
// are live.
// =============================================================================

export const CONTACT_ADDRESSES = {
  /** Anything a member needs from us, and the one the legal texts name. */
  support: "support@all.haus",
  /** General enquiries and press. */
  hello: "hello@all.haus",
  /** Reporting content or conduct. */
  report: "report@all.haus",
  /** Suspected fraud against a member or against the platform. */
  fraud: "fraud@all.haus",
  /** Data-protection requests (D8 §7's tooling will route here). */
  privacy: "privacy@all.haus",
  /** Vulnerability disclosure. */
  security: "security@all.haus",
} as const;

/** Declared as a runtime array with the type derived from it, never the other
 *  way round: a bare type can be compared against nothing, and the pin above
 *  has to enumerate them. */
export const CONTACT_ADDRESS_LIST = Object.values(CONTACT_ADDRESSES);

export type ContactAddress = (typeof CONTACT_ADDRESS_LIST)[number];
