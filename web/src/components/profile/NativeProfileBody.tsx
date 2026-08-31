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
// It also owns everything that spans tiers: the action pair (tier 1), the
// subscribe row (tier 2), and the Followers/Following count views, which are
// opened from a count in tier 2 and REPLACE the log in tier 4 (D11) — so their
// state cannot live in either tier alone.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
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
import { FollowersTab } from "./FollowersTab";
import { FollowingTab } from "./FollowingTab";
import {
  BarButton,
  ProfileBar,
  ProfileMeta,
  ProfileStatButton,
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

type CountView = "followers" | "following";

const LOG_REGION_ID = "profile-log";

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
  const [countView, setCountView] = useState<CountView | null>(null);

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

  const n = (v: number) => v.toLocaleString("en-GB");

  // ---- Tier 1's action pair -------------------------------------------------
  // A branch, not a gate (D6): own profile → Edit profile, no Message; logged
  // out → the single `Log in` link, because the SSR page is where strangers
  // land and the bar must read complete without auth (D12).
  const actions = authLoading ? null : !user ? (
    <Link
      href="/auth?mode=login"
      className="focus-ring text-ui-xs font-medium transition-opacity hover:opacity-70"
      style={{ color: palette.barText }}
    >
      Log in
    </Link>
  ) : isOwnProfile ? (
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

  // ---- Tier 2's stats line --------------------------------------------------
  // Mono, not sans (D4): counts are tabular data, and mono numerals sit still
  // while the tab content changes underneath them. Followers/Following are the
  // live links into their views (D11); RSS keeps its seat at the end (D12) —
  // it is the only HUMAN-visible RSS affordance, the <link rel="alternate">
  // metadata serving machines rather than readers.
  const stats = (
    <>
      {n(writer.articleCount)} ARTICLE{writer.articleCount === 1 ? "" : "S"}
      {" · "}
      <ProfileStatButton
        palette={palette}
        open={countView === "followers"}
        controls={LOG_REGION_ID}
        onClick={() =>
          setCountView((v) => (v === "followers" ? null : "followers"))
        }
      >
        {n(writer.followerCount)} FOLLOWER
        {writer.followerCount === 1 ? "" : "S"}
      </ProfileStatButton>
      {" · "}
      <ProfileStatButton
        palette={palette}
        open={countView === "following"}
        controls={LOG_REGION_ID}
        onClick={() =>
          setCountView((v) => (v === "following" ? null : "following"))
        }
      >
        {n(writer.followingCount)} FOLLOWING
      </ProfileStatButton>
      {" · "}
      <a
        href={`/rss/${username}`}
        className="hover:underline"
        style={{ color: "inherit" }}
      >
        RSS
      </a>
    </>
  );

  return (
    <ProfileSurface
      palette={palette}
      scheme={scheme}
      minHeight={minHeight}
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
        stats={stats}
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

      {/* Tiers 3–4. A count view REPLACES the log and the rig is simply absent
          while it is open — honest semantics, one path in, one path back (D11).
          An in-pane view swap is not a dismissal, so the `← back` here does not
          touch the overlay-close rule (cf. /admin/reports' `← Workspace`). */}
      <div id={LOG_REGION_ID}>
        {countView ? (
          <div>
            <div className="mb-6 flex items-center gap-4">
              <button
                type="button"
                onClick={() => setCountView(null)}
                className="btn-text-muted"
              >
                ← back
              </button>
              <h2 className="label-ui" style={{ color: palette.cardStandfirst }}>
                {countView === "followers"
                  ? `${n(writer.followerCount)} FOLLOWERS`
                  : `${n(writer.followingCount)} FOLLOWING`}
              </h2>
            </div>
            {countView === "followers" ? (
              <FollowersTab username={username} isOwnProfile={isOwnProfile} />
            ) : (
              <FollowingTab username={username} isOwnProfile={isOwnProfile} />
            )}
          </div>
        ) : (
          <WriterActivity
            username={username}
            writer={writer}
            isOwnProfile={isOwnProfile}
            palette={palette}
          />
        )}
      </div>
    </ProfileSurface>
  );
}
