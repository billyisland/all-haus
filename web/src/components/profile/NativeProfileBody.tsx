"use client";

// =============================================================================
// NativeProfileBody — the native writer profile (/:username), ONE body for both
// registers (PROFILE-PANE-REDESIGN-ADR W2/§5.1).
//
// The three headers this replaces drifted because they were three hand-written
// copies of one header, and "bring them into line" is the instruction that
// produced that state. So the body lives here once and each register passes its
// difference in as a prop — exactly the seam `ArticleLink`'s `onOpen` and
// `PublicationMasthead`'s `onNavigate` already use:
//
//   • the profile overlay (NativeProfilePanel) fetches the writer client-side
//     and passes `onClose`, which is what renders tier 1's ✕ (D10);
//   • /[username] fetches it server-side and passes it straight in — this is a
//     client component, so it still SSRs, and the page keeps its share/SEO HTML.
//     Having nothing to close, it passes no `onClose` and gets no ✕.
//
// It also owns the two things that span tiers: the action pair (tier 1) and the
// subscribe row (tier 2). Followers/Following used to be here too — counts in
// tier 2 that reached down and REPLACED the log in tier 4, which is why they
// needed a `← back`. They are now two of the five buttons in `WriterActivity`'s
// own row, so the whole of that navigation lives in one place with the region
// it drives (D11, as amended 2026-09-02).
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../stores/auth";
import { useResolvedDark } from "../../stores/colorScheme";
import type { FeedScheme } from "../workspace/tokens";
import {
  messages as messagesApi,
  trust as trustApi,
  type TrustProfileResponse,
  type WriterProfile,
} from "../../lib/api";
import { useFollows, useFollowState } from "../../stores/follows";
import { routeToOverlay } from "../../lib/workspace/overlays";
import { trustEnabled } from "../../lib/featureFlags";
import { TrustProfile } from "../trust/TrustProfile";
import { VouchModal } from "../trust/VouchModal";
import { WriterActivity } from "./WriterActivity";
import {
  BarButton,
  PROFILE_PANE_WIDTH,
  ProfileBar,
  ProfileMeta,
  ProfileSurface,
  profilePalette,
  protocolChipLabel,
  type ProfileIdentity,
} from "./ProfileChrome";

interface SubStatus {
  subscribed: boolean;
  ownContent?: boolean;
  status?: string;
  pricePence?: number;
  currentPeriodEnd?: string;
}

export function NativeProfileBody({
  username,
  writer,
  onClose,
  minHeight,
  scheme,
}: {
  username: string;
  writer: WriterProfile;
  /** The overlay register's alone — the standalone page has nothing to close. */
  onClose?: () => void;
  minHeight?: string;
  /** The launching feed's colourway (overlay register only): the pane wears it
   *  entire. Absent on the standalone page and on feed-agnostic launches. */
  scheme?: FeedScheme | null;
}) {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  // useResolvedDark, not useColorScheme().dark: /[username] is SSR'd, and the
  // store's `dark` only flips in a post-mount effect, so a dark-mode visitor
  // would paint light and snap (§4.2).
  const dark = useResolvedDark();
  const palette = profilePalette(scheme, dark);

  const isOwnProfile = user?.username === username;
  const following = useFollowState(writer.id);
  const [followLoading, setFollowLoading] = useState(false);
  const [msgLoading, setMsgLoading] = useState(false);
  const [subStatus, setSubStatus] = useState<SubStatus | null>(null);
  const [subLoading, setSubLoading] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);
  const [showVouchModal, setShowVouchModal] = useState(false);
  const [trustData, setTrustData] = useState<TrustProfileResponse | null>(null);
  const [trustKey, setTrustKey] = useState(0);

  // Subscription status (native follow state comes from the shared store).
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    fetch(`/api/v1/subscriptions/check/${writer.id}`, {
      credentials: "include",
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setSubStatus(data);
      })
      .catch(() => {
        if (!cancelled) setSubStatus({ subscribed: false });
      });
    return () => {
      cancelled = true;
    };
  }, [user, writer.id]);

  // Viewer's existing vouches, for the vouch modal. Skipped while trust is
  // parked — the UI that consumes it is hidden.
  useEffect(() => {
    if (!trustEnabled()) return;
    trustApi
      .getProfile(writer.id)
      .then(setTrustData)
      .catch(() => {});
  }, [writer.id, trustKey]);

  const handleToggleFollow = useCallback(async () => {
    if (!user) return;
    setFollowLoading(true);
    try {
      if (following) await useFollows.getState().unfollow(writer.id);
      else await useFollows.getState().follow(writer.id);
    } catch (err) {
      console.error("Follow error:", err);
    } finally {
      setFollowLoading(false);
    }
  }, [user, following, writer.id]);

  const handleMessage = useCallback(async () => {
    if (!user) return;
    setMsgLoading(true);
    try {
      const result = await messagesApi.createConversation([writer.id]);
      router.push(
        `/reader?overlay=messages&conversation=${result.conversationId}`,
      );
    } catch {
      router.push("/reader?overlay=messages");
    } finally {
      setMsgLoading(false);
    }
  }, [user, writer.id, router]);

  const handleSubscribe = useCallback(
    async (period: "monthly" | "annual") => {
      if (!user) return;
      setSubLoading(true);
      setSubError(null);
      try {
        const res = await fetch(`/api/v1/subscriptions/${writer.id}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ period }),
        });
        if (res.ok) {
          const data = await res.json();
          setSubStatus({
            subscribed: true,
            status: "active",
            pricePence: data.pricePence,
            currentPeriodEnd: data.currentPeriodEnd,
          });
        } else if (res.status === 402) {
          // card_required: subscriptions charge the reading tab, which needs a
          // card on file to be collectable.
          setSubError("Add a payment card in Settings to subscribe.");
        } else {
          setSubError("Subscription failed — try again.");
        }
      } catch (err) {
        console.error("Subscribe error:", err);
        setSubError("Subscription failed — try again.");
      } finally {
        setSubLoading(false);
      }
    },
    [user, writer.id],
  );

  const handleUnsubscribe = useCallback(async () => {
    if (!user) return;
    setSubLoading(true);
    try {
      const res = await fetch(`/api/v1/subscriptions/${writer.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        setSubStatus({
          subscribed: true,
          status: "cancelled",
          currentPeriodEnd: data.accessUntil,
        });
      }
    } catch (err) {
      console.error("Unsubscribe error:", err);
    } finally {
      setSubLoading(false);
    }
  }, [user, writer.id]);

  // The `verified` tier of the identity row (D7): network identities the
  // SUBJECT proved. A native profile can only ever draw this tier — an
  // assertion needs two external_sources endpoints, which is why the `+`
  // renders on external profiles only and a native identity row is display.
  const identities = useMemo<ProfileIdentity[]>(
    () =>
      (writer.presences ?? []).map((p) => ({
        key: `presence:${p.protocol}`,
        tier: "verified" as const,
        protocol: protocolChipLabel(p.protocol),
        label: p.handle ?? protocolChipLabel(p.protocol),
        href: p.externalUrl,
      })),
    [writer.presences],
  );

  // ---- Tier 1's action pair -------------------------------------------------
  // A branch, not a gate (D6): own profile → Edit profile, no Message.
  //
  // LOGGED OUT, TIER 1 CARRIES NOTHING (operator, 2026-09-02). D12 put a `Log
  // in` link here on the reasoning that "the SSR page is where strangers land
  // and the bar must read complete without auth" — written when this page had no
  // bar above it. It has had one since the sitewide top bar landed
  // (LOGGED-OUT-REGISTER-ADR §X), and that bar's logged-out right end IS `Log
  // in` + the waiting list, so the two sat forty pixels apart offering the same
  // destination. The register above owns the way in; the profile's own bar is
  // about the person it names. An action that is already on screen is not
  // completeness, it is repetition.
  const actions = authLoading || !user ? null : isOwnProfile ? (
    <BarButton
      palette={palette}
      variant="secondary"
      onClick={() => {
        // Inside the workspace this opens the settings overlay in place; on a
        // standalone page routeToOverlay is a no-op and the push carries it
        // there (the escape ban — web/CLAUDE.md).
        const href = "/reader?overlay=settings";
        if (!routeToOverlay(href)) router.push(href);
      }}
    >
      Edit profile
    </BarButton>
  ) : (
    <>
      <BarButton
        palette={palette}
        variant="secondary"
        onClick={handleMessage}
        disabled={msgLoading}
      >
        {msgLoading ? "…" : "Message"}
      </BarButton>
      <BarButton
        data-explain="profile.follow"
        palette={palette}
        variant={following ? "secondary" : "primary"}
        onClick={handleToggleFollow}
        disabled={followLoading}
      >
        {followLoading ? "…" : following ? "Following" : "Follow"}
      </BarButton>
    </>
  );

  // ---- Tier 2's subscribe row ----------------------------------------------
  // The profile's one money affordance earns settled ground rather than a
  // chrome band (D12). Hidden on own content — subStatus.ownContent already
  // carries that fact.
  const hasPaywall =
    writer.hasPaywalledArticle && writer.subscriptionPricePence > 0;
  const monthlyPence =
    subStatus?.pricePence ?? writer.subscriptionPricePence ?? 500;
  const discount = writer.annualDiscountPct ?? 15;
  const annualPence = Math.round(monthlyPence * 12 * (1 - discount / 100));

  const subscribeRow =
    user && !isOwnProfile && hasPaywall && subStatus && !subStatus.ownContent ? (
      <div
        data-explain="profile.subscribe"
        className="flex flex-wrap items-center gap-2"
      >
        {subStatus.subscribed ? (
          <button
            onClick={handleUnsubscribe}
            disabled={subLoading}
            className="btn-soft py-1.5 px-4 text-ui-xs disabled:opacity-50 transition-colors"
          >
            {subLoading
              ? "…"
              : subStatus.status === "cancelled"
                ? `Access until ${new Date(subStatus.currentPeriodEnd!).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`
                : "Subscribed"}
          </button>
        ) : (
          <>
            <button
              onClick={() => handleSubscribe("monthly")}
              disabled={subLoading}
              className="btn-accent py-1.5 px-4 text-ui-xs disabled:opacity-50 transition-colors"
            >
              {subLoading
                ? "…"
                : `Subscribe £${(monthlyPence / 100).toFixed(2)}/mo`}
            </button>
            {discount > 0 && (
              <button
                onClick={() => handleSubscribe("annual")}
                disabled={subLoading}
                className="btn-soft py-1.5 px-4 text-ui-xs disabled:opacity-50 transition-colors"
              >
                {subLoading ? "…" : `£${(annualPence / 100).toFixed(2)}/yr`}
              </button>
            )}
          </>
        )}
        {/* Trust stays parked; it is action-tier, so it joins this row if ever
            unparked rather than the identity band. */}
        {trustEnabled() && (
          <button
            onClick={() => setShowVouchModal(true)}
            className="btn-ghost py-1.5 px-4 text-ui-xs transition-colors"
          >
            Vouch
          </button>
        )}
        {subError && <span className="text-ui-xs text-crimson">{subError}</span>}
      </div>
    ) : null;

  return (
    <ProfileSurface
      palette={palette}
      scheme={scheme}
      minHeight={minHeight}
      // The standalone page has no pane to size it, so it takes the pane's own
      // width — the same seam that decides the ✕ (§5.1). In the overlay the
      // Glasshouse IS 860 and this must stay undefined, or the body would cap
      // itself inside a pane that is already capped.
      maxWidth={onClose ? undefined : PROFILE_PANE_WIDTH}
      bar={
        <ProfileBar
          palette={palette}
          avatarUrl={writer.avatar}
          name={writer.displayName ?? username}
          handle={`@${username}`}
          actions={actions}
          onClose={onClose}
        />
      }
    >
      <ProfileMeta
        palette={palette}
        bio={writer.bio}
        identities={identities}
        subscribeRow={subscribeRow}
      >
        {trustEnabled() && (
          <div className="mt-6">
            <TrustProfile userId={writer.id} key={trustKey} compact />
          </div>
        )}
      </ProfileMeta>

      {trustEnabled() && showVouchModal && (
        <VouchModal
          subjectId={writer.id}
          subjectName={writer.displayName ?? username}
          existingVouches={trustData?.viewerVouches ?? []}
          onClose={() => setShowVouchModal(false)}
          onVouched={() => {
            setShowVouchModal(false);
            setTrustKey((k) => k + 1);
          }}
        />
      )}

      {/* Tiers 3–4 — the five-view button row and the log it drives, which now
          own the Followers/Following views too (D11, as amended 2026-09-02).
          There is nothing left here to hold: the whole of that navigation lives
          with the region it changes. `inOverlay` rides `onClose`, this body's
          one register seam (§5.1) — in the overlay the pushed URL is the
          profile's own, so the ambient workspace `?tab` must not steer it. */}
      <WriterActivity
        username={username}
        writer={writer}
        isOwnProfile={isOwnProfile}
        palette={palette}
        inOverlay={!!onClose}
      />
    </ProfileSurface>
  );
}
