// modernhaus imports this directly; the full site reaches it through
// `hooks/usePostInteractions.ts`, which re-exports it.
// Pure capability gate — the protocol guards (VesselCard verbatim) + §7
// interact-back gate, with no React. `active` = the post can interact back at
// all (has an external_item id AND interactBack). Extracted so the guard matrix
// is unit-testable without a DOM harness.
export interface InteractionCaps {
  likeAllowed: boolean; // protocol permits a like at all
  repostAllowed: boolean;
  replyAllowed: boolean;
  likeEnabled: boolean; // permitted AND a linked account is present
  repostEnabled: boolean;
  replyEnabled: boolean;
  likeDisabled: boolean; // permitted but no linked account (shows a disabled affordance)
  repostDisabled: boolean;
  replyDisabled: boolean;
}

export function interactionCaps(
  protocol: string,
  hasAccount: boolean,
  active: boolean,
): InteractionCaps {
  if (!active) {
    return {
      likeAllowed: false,
      repostAllowed: false,
      replyAllowed: false,
      likeEnabled: false,
      repostEnabled: false,
      replyEnabled: false,
      likeDisabled: false,
      repostDisabled: false,
      replyDisabled: false,
    };
  }
  const isRss = protocol === "rss";
  const isEmail = protocol === "email";
  const isNostr = protocol === "nostr_external";
  const likeAllowed = !isRss && !isEmail; // like + reply share the same suppression
  const repostAllowed = !isRss && !isEmail && !isNostr;
  const replyAllowed = !isRss && !isEmail;
  return {
    likeAllowed,
    repostAllowed,
    replyAllowed,
    likeEnabled: likeAllowed && hasAccount,
    repostEnabled: repostAllowed && hasAccount,
    replyEnabled: replyAllowed && hasAccount,
    likeDisabled: likeAllowed && !hasAccount,
    repostDisabled: repostAllowed && !hasAccount,
    replyDisabled: replyAllowed && !hasAccount,
  };
}
