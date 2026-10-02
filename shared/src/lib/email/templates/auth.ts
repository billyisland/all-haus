import { CONTACT_ADDRESSES } from "../../contact-addresses.js";
import { formatMomentUtc } from "../format.js";
import { button, fine, mail, p, strong, type EmailContent } from "../layout.js";

// =============================================================================
// Signing in, changing address, and exporting the account.
// =============================================================================

export function magicLinkEmail(args: {
  verifyUrl: string;
  expiresInMinutes: number;
}): EmailContent {
  return {
    subject: "Your all.haus login link",
    heading: "Your way in",
    blocks: [
      p(`Here's your link. It remains valid for the next ${args.expiresInMinutes} minutes and works once. If you need to, you can request another one at all.haus.`),
      button(args.verifyUrl, "Log in"),
      fine("Didn't ask for it? Then ignore it, and it will lapse unused."),
    ],
  };
}

export function emailChangeVerificationEmail(args: { verifyUrl: string }): EmailContent {
  return {
    subject: "Confirm your new address — all.haus",
    heading: "Confirm your new address",
    blocks: [
      p("Someone (we hope you) has asked to change your registered email address on all.haus. Confirm to make this the address you log in with and where we write to you."),
      button(args.verifyUrl, "Confirm address"),
      fine("If it wasn't you, ignore this. Nothing changes unless the link is used."),
    ],
  };
}

// Sent to the address an email change REPLACED, on the confirm (migration 273).
// The old address is the one channel a stolen session cannot have moved, so
// the undo lives here. The export hold is named because it is why the undo is
// worth pressing: the key cannot leave while the link is still good.
export function emailChangedNoticeEmail(args: {
  newEmailMasked: string;
  changedAt: Date;
  undoUrl: string;
  holdDays: number;
}): EmailContent {
  return {
    subject: "Your all.haus email address was changed",
    heading: "Your email address was changed",
    blocks: [
      p(
        "On ",
        strong(formatMomentUtc(args.changedAt)),
        ` the address you log in with was changed from this one to ${args.newEmailMasked}. Every other device was logged out at the same time. If that was you, there's nothing more to do.`,
      ),
      p(
        `If it wasn't, press the button. It puts this address back and logs out every device, including whoever made the change. It works once, for the next ${args.holdDays} days, and for as long as it works nobody can export your account.`,
      ),
      button(args.undoUrl, "Undo the change"),
      p(
        "Then log in again with this address, and write to ",
        mail(CONTACT_ADDRESSES.support),
        " so we can look at what else was done.",
      ),
    ],
  };
}

// The step-up is a CONFIRMATION, never a refusal: the export is mandated by the
// custodial-identity rule, so nothing here may become a way to withhold a
// member's own key from them. The notice below is what turns a silent theft
// into a dated event the member can point at.
export function keyExportStepUpEmail(args: {
  confirmUrl: string;
  expiresInMinutes: number;
}): EmailContent {
  return {
    subject: "Confirm your all.haus account export",
    heading: "Confirm your export",
    blocks: [
      p(
        "Someone has asked to export your all.haus account, Nostr secret key included. That key isn't a password to your identity so much as the identity itself, so we'd like to be sure it was you.",
      ),
      p(`The link works once, for the next ${args.expiresInMinutes} minutes.`),
      button(args.confirmUrl, "Confirm the export"),
      p(
        "If it wasn't you, don't press the link, and nothing will leave us. Then log out of all.haus, which logs you out on every device, and write to ",
        mail(CONTACT_ADDRESSES.support),
        ".",
      ),
    ],
  };
}

export function keyExportNoticeEmail(args: { exportedAt: Date }): EmailContent {
  return {
    subject: "Your all.haus account was exported",
    heading: "Your account has been exported",
    blocks: [
      p(
        "Your account export, Nostr secret key and all, was downloaded on ",
        strong(formatMomentUtc(args.exportedAt)),
        ". If that was you, the file is yours and there's nothing more to do.",
      ),
      p(
        "If it wasn't, somebody else now holds your identity, and that key can't be swapped for a new one. Write to us at once at ",
        mail(CONTACT_ADDRESSES.support),
        ".",
      ),
    ],
  };
}
