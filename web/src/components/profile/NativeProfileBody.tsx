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
import { ReportButton } from "../ui/ReportButton";
import { MuteBlockControls } from "../social/MuteBlockControls";
import { useRouter } from "next/navigation";
import { useAuth } from "../../stores/auth";
import { auth as authApi } from "../../lib/api/auth";
import { mapSubscribeError } from "../../lib/subscribe-errors";
import { TermsConsent } from "../legal/TermsConsent";
import { useResolvedDark } from "../../stores/colorScheme";
import type { FeedScheme } from "../workspace/tokens";
import type { ProfileFocus } from "../../stores/profileOverlay";
import {
  messages as messagesApi,
  subscriptions as subscriptionsApi,
  trust as trustApi,
  type TrustProfileResponse,
  type WriterProfile,
} from "../../lib/api";
import { useFollowState } from "../../stores/follows";
import { ProfileFollowControl } from "./ProfileFollowControl";
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
import { TERMS_PURPOSE, termsVersionMismatch, TERMS_ACCEPT_FAILED } from "../../content/terms-consent";
import {
  UNSUBSCRIBE_FAILED,
  SUBSCRIBED,
  SUBSCRIBE_ACCEPT,
  subscribeMonthlyLabel,
  subscribeAnnualLabel,
} from "../../content/ledger";

interface SubStatus {
  subscribed: boolean;
  ownContent?: boolean;
  status?: string;
  pricePence?: number;
  currentPeriodEnd?: string;
}

// The bar's text actions — Mute, Block, Report — share one register.
const BAR_TEXT_ACTION =
  "font-mono text-mono-xs uppercase tracking-[0.02em] hover:opacity-80";

export function NativeProfileBody({
  username,
  writer,
  onClose,
  minHeight,
  scheme,
  focus,
  tab = null,
}: {
  username: string;
  writer: WriterProfile;
  /** The overlay register's alone — the standalone page has nothing to close. */
  onClose?: () => void;
  minHeight?: string;
  /** The conversation the pane was opened ON — overlay register only. */
  focus?: ProfileFocus | null;
  /** The view the pane was asked to open on — see `ProfileOpenOptions.tab`. */
  tab?: string | null;
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
  const [msgLoading, setMsgLoading] = useState(false);
  const [subStatus, setSubStatus] = useState<SubStatus | null>(null);
  const [subLoading, setSubLoading] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);
  // The Reader Terms refusal (§0z item 5). Holds the PERIOD that was pressed,
  // because accepting resumes that press rather than asking for it again — and
  // the consent REPLACES the two subscribe buttons while it is up.
  const [subNeedsTerms, setSubNeedsTerms] = useState<"monthly" | "annual" | null>(null);
  const [termsChecked, setTermsChecked] = useState(false);
  const [acceptingTerms, setAcceptingTerms] = useState(false);
  const [showVouchModal, setShowVouchModal] = useState(false);
  const [trustData, setTrustData] = useState<TrustProfileResponse | null>(null);
  const [trustKey, setTrustKey] = useState(0);

  // Subscription status (native follow state comes from the shared store).
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    subscriptionsApi
      .check(writer.id)
      .then((data) => {
        if (!cancelled) setSubStatus(data);
      })
      .catch((err) => {
        // A check that FAILED asserts nothing: offering Subscribe to somebody
        // who may already be subscribed would be a claim we cannot make, so
        // the row stays unknown (hidden) rather than reading "not subscribed".
        console.error("Subscription check failed:", err);
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


  // Open the messages overlay in place inside the workspace; navigate to it on
  // a standalone /:username page. Going through `routeToOverlay` is what makes
  // the button work at all: this pane is nearly always ALREADY on /reader, and
  // a router.push to the pathname you are on re-runs nothing — so the plain
  // push it used to do opened no surface anywhere (S19). The helper answers
  // false off the workspace, where MessagesOverlay is not mounted, so the push
  // still carries it there and the mount-time dispatcher opens it.
  const handleMessage = useCallback(async () => {
    if (!user) return;
    setMsgLoading(true);
    let href = "/reader?overlay=messages";
    try {
      const result = await messagesApi.createConversation([writer.id]);
      href = `/reader?overlay=messages&conversation=${encodeURIComponent(result.conversationId)}`;
    } catch {
      // Fall through to the inbox with nothing selected.
    } finally {
      setMsgLoading(false);
    }
    if (!routeToOverlay(href)) router.push(href);
  }, [user, writer.id, router]);

  const handleSubscribe = useCallback(
    async (period: "monthly" | "annual") => {
      if (!user) return;
      setSubLoading(true);
      setSubError(null);
      try {
        const data = await subscriptionsApi.subscribe(writer.id, { period });
        setSubNeedsTerms(null);
        setSubStatus({
          subscribed: true,
          status: "active",
          pricePence: data.pricePence,
          currentPeriodEnd: data.currentPeriodEnd,
        });
      } catch (err) {
        // One mapper for every subscribe surface (lib/subscribe-errors.ts).
        // A card-holder who has never been shown the Reader Terms gets the
        // acceptance in place of the buttons, and on accept the period they
        // pressed is re-sent; every other refusal — a dropped connection
        // included — is a sentence.
        const view = mapSubscribeError(err);
        if (view.needsTerms) setSubNeedsTerms(period);
        else setSubError(view.message);
      } finally {
        setSubLoading(false);
      }
    },
    [user, writer.id],
  );

  // ACCEPT, THEN RESUME THE PRESS. The version is the server's own `current`
  // off the auth store, and `/auth/me` is refreshed before the retry so the
  // row cannot loop on a stale session — the same shape as the paywall gate's
  // `handleAcceptReaderTerms`. A refused acceptance (the text moved between
  // render and press) is SHOWN, and the member is asked again.
  const handleAcceptTerms = useCallback(async () => {
    const version = user?.terms.reader.current;
    const period = subNeedsTerms;
    if (!version || !period) return;
    setAcceptingTerms(true);
    setSubError(null);
    try {
      await authApi.acceptTerms("reader", version);
      await useAuth.getState().fetchMe();
      setSubNeedsTerms(null);
      setTermsChecked(false);
      await handleSubscribe(period);
    } catch (err) {
      const code = (err as { body?: { error?: string } })?.body?.error;
      setSubError(
        code === "terms_version_mismatch"
          ? termsVersionMismatch('reader')
          : TERMS_ACCEPT_FAILED,
      );
      await useAuth.getState().fetchMe();
    } finally {
      setAcceptingTerms(false);
    }
  }, [user, subNeedsTerms, handleSubscribe]);

  const handleUnsubscribe = useCallback(async () => {
    if (!user) return;
    setSubLoading(true);
    setSubError(null);
    try {
      const data = await subscriptionsApi.unsubscribe(writer.id);
      setSubStatus({
        subscribed: true,
        status: "cancelled",
        currentPeriodEnd: data.accessUntil,
      });
    } catch (err) {
      console.error("Unsubscribe error:", err);
      setSubError(UNSUBSCRIBE_FAILED);
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
      {/* Follow is the feed picker, not a bare graph toggle: a profile is a
          feed-less surface, so nothing here can decide which feed a follow
          lands in and the reader is asked (§9.16). The live store value is
          handed in as the snapshot, so the picker's label and this surface's
          cannot disagree. */}
      <ProfileFollowControl
        target={{ type: "user", id: writer.id, isFollowing: following }}
        palette={palette}
      />
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
                : SUBSCRIBED}
          </button>
        ) : subNeedsTerms ? (
          // THE TERMS REFUSAL REPLACES THE SUBSCRIBE BUTTONS, it does not sit
          // beside them: two live primaries for one blocked act would leave
          // the member pressing the one that cannot work. One button, and it
          // says what the press does.
          <div className="w-full">
            <TermsConsent
              kind="reader"
              checked={termsChecked}
              onChange={setTermsChecked}
              purpose={TERMS_PURPOSE.subscribe}
              state={user?.terms.reader ?? null}
              disabled={acceptingTerms}
            />
            <button
              onClick={handleAcceptTerms}
              disabled={!termsChecked || acceptingTerms || subLoading}
              className="btn-accent py-1.5 px-4 text-ui-xs disabled:opacity-50 transition-colors"
            >
              {acceptingTerms || subLoading ? "…" : SUBSCRIBE_ACCEPT}
            </button>
          </div>
        ) : (
          <>
            <button
              onClick={() => handleSubscribe("monthly")}
              disabled={subLoading}
              className="btn-accent py-1.5 px-4 text-ui-xs disabled:opacity-50 transition-colors"
            >
              {subLoading
                ? "…"
                : subscribeMonthlyLabel(monthlyPence)}
            </button>
            {discount > 0 && (
              <button
                onClick={() => handleSubscribe("annual")}
                disabled={subLoading}
                className="btn-soft py-1.5 px-4 text-ui-xs disabled:opacity-50 transition-colors"
              >
                {subLoading ? "…" : subscribeAnnualLabel(annualPence)}
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
          actions={
            // The action slot is a ROW, because a profile carries more than
            // one act: whatever the host supplied (Message / Follow / Edit),
            // and — since L6.3 — reporting the person, which is the whole
            // reason D1 §9.2 says reporting covers more than content. Not on
            // your own profile, where there is nobody to report to.
            // W2 put Mute and Block in the same row, in Report's register, and
            // behind the same gate plus a session: they are acts on a
            // relationship, and a logged-out reader has none to act on.
            <div className="flex items-center gap-3">
              {actions}
              {user && user.id !== writer.id && (
                <MuteBlockControls
                  userId={writer.id}
                  name={writer.displayName ?? `@${username}`}
                  initial={writer.viewer}
                  triggerClassName={BAR_TEXT_ACTION}
                />
              )}
              {user?.id !== writer.id && (
                <ReportButton
                  targetProfileId={writer.id}
                  label="Report"
                  triggerClassName={BAR_TEXT_ACTION}
                />
              )}
            </div>
          }
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
        focus={focus}
        tab={tab}
      />
    </ProfileSurface>
  );
}
