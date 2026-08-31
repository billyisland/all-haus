"use client";

// =============================================================================
// Welcome — the first-session sheet (CONSOLIDATED-TODO §3.3, the writer/reader
// onboarding gap; REDESIGN-SCOPE §180's "own small design pass").
//
// SUPERSEDES `BringYourWorld`, which was explicitly a stand-in until this built
// (FOLLOW-GRAPH-IMPORT-ADR §7.4 / Phase 3) — its import offer is step 2 here,
// unchanged in substance and still a pure offer.
//
// WHAT IT IS FOR. Every account in the closed beta is provisioned by
// `provisionAccount(email, email.split('@')[0])`: the display name is the
// email's local part and the username is derived from that. So an admitted
// member lands in the workspace called `ejklake`, with no photo and no bio, and
// before this nothing ever asked them to fix it. Step 1 is that repair, and it
// is the only step every member sees.
//
// READER-FIRST, WITH A WRITER BRANCH (owner decision, 2026-08-07). §3.3 was
// drafted as "profile → first article → pricing", from a frontend audit written
// before the beta went readers-first. Marching someone admitted to READ through
// a pricing form states the wrong thing about the platform, so publishing is one
// OFFER on step 3 rather than two mandatory steps. PRINCIPLES.md's symmetry is
// "about primitives, not about onboarding" — the tools are legitimately
// asymmetric, so the onboarding may be too.
//
// EVERY STEP IS SKIPPABLE AND NOTHING HERE ACTS BY ITSELF. Next always advances;
// the ✕ always closes; no step blocks on a field. Follow-import in particular is
// bound by FOLLOW-GRAPH-IMPORT-ADR D3/D7, which names "signup step" among the
// things that may NOT auto-materialise a remote graph — so step 2 renders the
// same offer the Network panel does and imports only on an explicit act inside
// it. PRINCIPLES.md:153 asks for gentle nudging "without making it feel like a
// tutorial"; that is the whole brief for the copy here.
//
// GATED ON `accounts.onboarded_at` (migration 176), NOT a localStorage key. The
// two older seen-flags are per-device, which is right for a one-off animation
// and wrong for this: a member who has introduced themselves must not be asked
// again on their laptop because they first signed in on their phone. The caller
// owns the gate and the stamp; this component just reports that it is finished.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { Glasshouse } from "./Glasshouse";
import { FollowImportSection } from "../network/FollowImportSection";
import { useFollowImportRun } from "../../hooks/useFollowImportRun";
import { getNetworkCapabilities } from "../../lib/api/linked-accounts";
import { useAuth } from "../../stores/auth";
import { auth, account as accountApi } from "../../lib/api";
import { uploadImage } from "../../lib/media";
import { useEditorOverlay } from "../../stores/editorOverlay";
import { useIsMobile } from "../../hooks/useIsMobile";

type StepId = "you" | "world" | "publish" | "tour";

export function Welcome({
  onClose,
  onLaunchTour,
}: {
  /** Answered — completed or dismissed. The caller stamps `onboarded_at`. */
  onClose: () => void;
  /**
   * Accepted the tour offer. The caller must close this sheet FIRST and open
   * first-run after the unmount commits: floor-mode Explain sits below the
   * Glasshouse band by design (CLAUDE.md, Stacking order), so a tour opened
   * under a live pane renders behind it.
   */
  onLaunchTour: () => void;
}) {
  const isMobile = useIsMobile();
  const [caps, setCaps] = useState<{
    importable: string[];
    opml: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getNetworkCapabilities()
      .then((c) => {
        if (cancelled) return;
        setCaps({
          importable: c?.followImportProtocols ?? [],
          opml: c?.followImportOpml ?? false,
        });
      })
      .catch(() => {
        if (!cancelled) setCaps({ importable: [], opml: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The step list is computed, not fixed, so a step with nothing to offer is
  // ABSENT rather than rendered empty — BringYourWorld's own rule ("the offer
  // either appears complete or not at all"), carried forward. `world` needs live
  // import capabilities (dark `FOLLOW_IMPORT_ENABLED` ⇒ no step, which is the
  // current beta state); `tour` is desktop-only because floor-mode Explain
  // annotates the canvas, which mobile does not have.
  //
  // BUT IT IS LOCKED AT OPEN, and the sheet waits for the answer rather than
  // opening on a provisional one. Capabilities resolve after the first paint,
  // so a member who had already pressed Next was moved BACKWARDS when `world`
  // spliced in at index 1 — the step they were reading became a step they had
  // not seen, and the count grew under them. Clamping the index (what this did
  // before) fixes the overflow and not the jump. `isMobile` is frozen by the
  // same ref for the same reason: a resize mid-flow must not add or drop `tour`
  // beneath the member.
  const stepsRef = useRef<StepId[] | null>(null);
  if (!stepsRef.current && caps) {
    const s: StepId[] = ["you"];
    if (caps.importable.length > 0 || caps.opml) s.push("world");
    s.push("publish");
    if (!isMobile) s.push("tour");
    stepsRef.current = s;
  }
  const steps = stepsRef.current;

  const [index, setIndex] = useState(0);

  // Every hook above this line, per the rules of hooks. The wait is a beat of
  // nothing rather than a spinner: the sheet is arriving over a workspace that
  // is itself still settling, and a frame of chrome that then re-lays-out is
  // worse than one that simply appears. `getNetworkCapabilities` resolves on
  // failure too, so this cannot hang on a dead gateway.
  if (!steps) return null;

  const step = steps[index];
  const isLast = index === steps.length - 1;

  function next() {
    if (isLast) onClose();
    else setIndex(index + 1);
  }

  return (
    <Glasshouse onClose={onClose} maxWidth={620} ariaLabel="Welcome">
      <div className="px-6 sm:px-10 py-10">
        <p className="label-ui text-grey-600">
          {index + 1} / {steps.length}
        </p>

        <div className="mt-6">
          {step === "you" && <YouStep />}
          {step === "world" && caps && (
            <WorldStep importable={caps.importable} opml={caps.opml} />
          )}
          {step === "publish" && <PublishStep onOpenEditor={onClose} />}
          {step === "tour" && <TourStep />}
        </div>

        {/* Footer. Nothing is drawn above it — the gap is the separation, per
            the sitewide ban on single-pixel rules. Back is ABSENT on the first
            step rather than disabled, because a disabled control still asks to
            be read and then refuses. */}
        <div className="mt-10 flex items-center justify-between gap-4">
          <div>
            {index > 0 && (
              <button
                type="button"
                className="btn-text-muted"
                onClick={() => setIndex(index - 1)}
              >
                Back
              </button>
            )}
          </div>
          <div className="flex items-center gap-5">
            {step === "tour" ? (
              <>
                <button type="button" className="btn-text-muted" onClick={onClose}>
                  No thanks
                </button>
                <button type="button" className="btn" onClick={onLaunchTour}>
                  Show me
                </button>
              </>
            ) : (
              <button type="button" className="btn" onClick={next}>
                {isLast ? "Done" : "Next"}
              </button>
            )}
          </div>
        </div>
      </div>
    </Glasshouse>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — who you are. The one step everybody sees, and the one that repairs a
// real defect rather than offering a feature.
// ---------------------------------------------------------------------------

function YouStep() {
  const { user, fetchMe } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [bio, setBio] = useState(user?.bio ?? "");
  const [avatar, setAvatar] = useState<string | null>(user?.avatar ?? null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;

  // The derived name is the email's local part (`provisionAccount`). Saying so
  // is more useful than a generic prompt: it explains why the field looks the
  // way it does, and it makes clear nobody chose it for them.
  const looksDerived =
    !!user.email &&
    (user.displayName ?? "").toLowerCase() ===
      user.email.split("@")[0].toLowerCase();

  async function handleAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const result = await uploadImage(file);
      setAvatar(result.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await auth.updateProfile({
        displayName: displayName.trim() || undefined,
        bio: bio.trim(),
        avatar,
      });
      await fetchMe();
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const initial = (displayName || user.username || "?")[0].toUpperCase();

  return (
    <>
      <h1 className="font-sans text-2xl font-medium text-black tracking-tight">
        Say who you are
      </h1>
      <p className="text-ui-sm text-grey-600 mt-2 leading-relaxed">
        {looksDerived
          ? "We had to call you something, so we used your email address. You can do better than that."
          : "A name, a face and a line about yourself. All of it optional, all of it changeable later."}
      </p>

      <div className="mt-8 space-y-8">
        <div>
          <label className="block label-ui text-grey-600 mb-3">Photo</label>
          <div className="flex items-center gap-4">
            {avatar ? (
              <img
                src={avatar}
                alt=""
                className="h-16 w-16 object-cover flex-shrink-0"
              />
            ) : (
              <span
                className="flex h-16 w-16 items-center justify-center text-xl font-medium text-black flex-shrink-0"
                style={{
                  background:
                    "linear-gradient(135deg, var(--ah-blush), var(--ah-blush-deep))",
                }}
              >
                {initial}
              </span>
            )}
            <label className="btn-soft py-1.5 px-4 text-ui-xs cursor-pointer">
              {uploading ? "Uploading…" : "Upload photo"}
              <input
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                onChange={handleAvatar}
                disabled={uploading}
                className="hidden"
              />
            </label>
          </div>
        </div>

        <div>
          <label
            htmlFor="welcome-name"
            className="block label-ui text-grey-600 mb-2"
          >
            Display name
          </label>
          <input
            id="welcome-name"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={100}
            placeholder={user.username ?? ""}
            className="w-full bg-glasshouse-well px-4 py-2.5 text-sm text-black placeholder-grey-300 focus:outline-none"
          />
        </div>

        <div>
          <label
            htmlFor="welcome-bio"
            className="block label-ui text-grey-600 mb-2"
          >
            Bio
          </label>
          <textarea
            id="welcome-bio"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder="A few words about yourself"
            className="w-full bg-glasshouse-well px-4 py-2.5 text-sm text-black placeholder-grey-300 focus:outline-none resize-none"
          />
        </div>

        {error && <p className="text-ui-sm text-crimson">{error}</p>}

        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || uploading}
            className="btn-soft py-2 px-5 text-ui-sm"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {saved && <span className="text-ui-sm text-grey-600">Saved</span>}
        </div>

        {/* The handle is deliberately NOT editable here. It carries a 30-day
            cooldown (`UsernameChange`), and a hasty choice made in a welcome
            sheet would lock a member out of correcting it for a month — exactly
            the wrong stake for a first pass. Naming it is enough. */}
        {user.username && (
          <p className="text-ui-xs text-grey-600 leading-relaxed">
            Your handle is{" "}
            <span className="text-mono-xs">@{user.username}</span>.
            That one is changeable in Settings, but only once a month — so it is
            worth a think rather than a guess.
          </p>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — the import offer, carried over from BringYourWorld verbatim in
// substance. Still a pure offer (ADR D7): nothing imports until the user acts
// inside `FollowImportSection`.
// ---------------------------------------------------------------------------

function WorldStep({
  importable,
  opml,
}: {
  importable: string[];
  opml: boolean;
}) {
  const followImport = useFollowImportRun();
  return (
    <>
      <h1 className="font-sans text-2xl font-medium text-black tracking-tight">
        Bring your world
      </h1>
      <p className="text-ui-sm text-grey-600 mt-2 leading-relaxed">
        You don&rsquo;t have to start from an empty room. If you already follow
        people somewhere else, all.haus can rebuild that reading life here as a
        feed — and nothing changes on the other network.
      </p>
      <div className="mt-8">
        <FollowImportSection
          importable={importable}
          opml={opml}
          followImport={followImport}
        />
      </div>
      <p className="text-ui-xs text-grey-600 mt-8 leading-relaxed">
        No rush — this lives in the Network panel and every feed&rsquo;s
        &ldquo;Add a source&rdquo; field whenever you&rsquo;re ready. Started
        imports keep filling in the background.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — publishing, as an offer. Collapsed by default: a reader should be
// able to pass this in one click without reading a pricing form.
// ---------------------------------------------------------------------------

function PublishStep({ onOpenEditor }: { onOpenEditor: () => void }) {
  const { fetchMe } = useAuth();
  const [open, setOpen] = useState(false);
  const [subPrice, setSubPrice] = useState("");
  const [annualDiscount, setAnnualDiscount] = useState("15");
  const [priceMode, setPriceMode] = useState<"auto" | "fixed">("auto");
  const [fixedPrice, setFixedPrice] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const monthlyPence = Math.round(parseFloat(subPrice || "0") * 100);
  const discountPct = parseInt(annualDiscount || "0", 10);
  const annualPence = Math.round(monthlyPence * 12 * (1 - discountPct / 100));

  async function handleSave() {
    const pence = Math.round(parseFloat(subPrice) * 100);
    if (isNaN(pence) || pence < 0) {
      setMsg("Enter a valid price.");
      return;
    }
    if (isNaN(discountPct) || discountPct < 0 || discountPct > 30) {
      setMsg("Discount must be 0–30%.");
      return;
    }
    const fixedPence =
      priceMode === "fixed" ? Math.round(parseFloat(fixedPrice || "0") * 100) : null;
    if (priceMode === "fixed" && (isNaN(fixedPence!) || fixedPence! < 0)) {
      setMsg("Enter a valid per-article price.");
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      await accountApi.updateSubscriptionPrice(pence, discountPct, fixedPence);
      await fetchMe();
      setMsg("Saved. You can change these any time in the dashboard.");
    } catch {
      setMsg("Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  function openEditor() {
    // Leaving the welcome to go and write is a legitimate ending — the caller's
    // onClose stamps `onboarded_at`, so the sheet is answered rather than
    // abandoned, and opening the editor Glasshouse would supersede this one
    // anyway (one-Glasshouse-at-a-time). Close explicitly so the order is ours.
    onOpenEditor();
    useEditorOverlay.getState().open();
  }

  return (
    <>
      <h1 className="font-sans text-2xl font-medium text-black tracking-tight">
        You can publish here too
      </h1>
      <p className="text-ui-sm text-grey-600 mt-2 leading-relaxed">
        The same account reads and writes — there is no separate writer sign-up.
        If you want to be paid for what you publish, you can set your prices now.
        Most people would rather read for a while first, and that is the right
        instinct.
      </p>

      {!open ? (
        <div className="mt-8 flex flex-wrap items-center gap-5">
          <button
            type="button"
            className="btn-soft py-2 px-5 text-ui-sm"
            onClick={() => setOpen(true)}
          >
            Set my prices
          </button>
          <button type="button" className="btn-text" onClick={openEditor}>
            Write something now →
          </button>
        </div>
      ) : (
        <div className="mt-8 space-y-8">
          <div>
            <label className="block label-ui text-grey-600 mb-3">
              Subscription
            </label>
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <span className="text-ui-sm text-grey-600">£</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={subPrice}
                  onChange={(e) => setSubPrice(e.target.value)}
                  placeholder="3.00"
                  className="w-28 bg-glasshouse-well px-3 py-2 text-sm text-black placeholder-grey-300 focus:outline-none"
                />
                <span className="text-ui-xs text-grey-600">/month</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-ui-sm text-grey-600 w-[13px]">%</span>
                <input
                  type="number"
                  min="0"
                  max="30"
                  value={annualDiscount}
                  onChange={(e) => setAnnualDiscount(e.target.value)}
                  placeholder="15"
                  className="w-28 bg-glasshouse-well px-3 py-2 text-sm text-black placeholder-grey-300 focus:outline-none"
                />
                <span className="text-ui-xs text-grey-600">annual discount</span>
              </div>
              {monthlyPence > 0 && (
                <p className="text-ui-xs text-grey-600">
                  Readers pay £{subPrice}/mo or £{(annualPence / 100).toFixed(2)}
                  /year{discountPct > 0 ? ` (save ${discountPct}%)` : ""}
                </p>
              )}
            </div>
          </div>

          <div>
            <label className="block label-ui text-grey-600 mb-3">
              Paid articles
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPriceMode("auto")}
                className={`toggle-chip label-ui ${
                  priceMode === "auto"
                    ? "toggle-chip-active"
                    : "toggle-chip-inactive"
                }`}
              >
                Scale with length
              </button>
              <button
                type="button"
                onClick={() => setPriceMode("fixed")}
                className={`toggle-chip label-ui ${
                  priceMode === "fixed"
                    ? "toggle-chip-active"
                    : "toggle-chip-inactive"
                }`}
              >
                Fixed price
              </button>
            </div>
            {priceMode === "fixed" && (
              <div className="mt-4 flex items-center gap-3">
                <span className="text-ui-sm text-grey-600">£</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={fixedPrice}
                  onChange={(e) => setFixedPrice(e.target.value)}
                  placeholder="0.20"
                  className="w-28 bg-glasshouse-well px-3 py-2 text-sm text-black placeholder-grey-300 focus:outline-none"
                />
                <span className="text-ui-xs text-grey-600">per read</span>
              </div>
            )}
            <p className="text-ui-xs text-grey-600 mt-3 leading-relaxed">
              A default only — every article can override it in the editor, and
              free articles are always free.
            </p>
          </div>

          {msg && <p className="text-ui-xs text-grey-600">{msg}</p>}

          <div className="flex flex-wrap items-center gap-5">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="btn-soft py-2 px-5 text-ui-sm"
            >
              {saving ? "Saving…" : "Save prices"}
            </button>
            <button type="button" className="btn-text" onClick={openEditor}>
              Write something now →
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — the tour, OFFERED rather than sprung.
//
// The six-beat first-run program has existed since 2026-07-15 and was switched
// off the same day: EXPLAIN-ADR amendment 1 records that "landing in Explain
// mode on load without asking for it read as a malfunction, not a welcome".
// That was a verdict on the ENTRY, not on the tour — so the tour survives and
// the entry becomes a question. `FirstRunController` stays dormant.
// ---------------------------------------------------------------------------

function TourStep() {
  return (
    <>
      <h1 className="font-sans text-2xl font-medium text-black tracking-tight">
        Want a look round?
      </h1>
      <p className="text-ui-sm text-grey-600 mt-2 leading-relaxed">
        Six stops around the workspace — what a feed is, where things come from,
        and what the controls do. It takes about a minute and you can leave at
        any point.
      </p>
      <p className="text-ui-xs text-grey-600 mt-8 leading-relaxed">
        If you would rather poke about on your own, that is the better way to
        learn it anyway. The same tour is under the ∀ menu whenever you want it.
      </p>
    </>
  );
}
