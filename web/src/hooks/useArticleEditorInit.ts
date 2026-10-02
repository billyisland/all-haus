"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "../stores/auth";
import { request, ApiError } from "../lib/api/client";
import type { PublishData, PublicationContext } from "../components/editor/ArticleEditor";
import { publishArticle, publishToPublication } from "../lib/publish";
import { loadDraft, saveDraft, scheduleDraft, deleteDraft } from "../lib/drafts";
import {
  publications as publicationsApi,
  tags as tagsApi,
} from "../lib/api";
import { publicationsEnabled } from "../lib/featureFlags";

// =============================================================================
// useArticleEditorInit — the data-loading + publish/schedule logic shared by the
// standalone /write page and the workspace EditorOverlay. Extracted from
// app/write/page.tsx so the two callers don't drift. The only thing that differs
// between them is post-publish navigation, expressed via onComplete.
// =============================================================================

export interface ArticleEditorInitialData {
  title: string;
  dek: string;
  content: string;
  gatePosition: number;
  price: number;
  commentsEnabled: boolean;
  tags?: string[];
  /** Set when continuing a saved draft — pins the editor's saves to that row. */
  draftId?: string;
  editingEventId?: string;
  editingDTag?: string;
  publicationId?: string | null;
  coverImageUrl?: string | null;
}

export interface ArticleEditorCompleteDest {
  overlay: "dashboard";
  context?: string;
  tab?: string;
}

interface UseArticleEditorInitOpts {
  editEventId: string | null;
  draftId: string | null;
  pubSlug: string | null;
  /** Note→article seed (overlay only); /write passes neither. */
  seedContent?: string | null;
  seedTitle?: string | null;
  onComplete: (dest: ArticleEditorCompleteDest) => void;
}

export interface ArticleEditorInit {
  initialData: ArticleEditorInitialData | null;
  pubMemberships: PublicationContext[];
  initialPubId: string | null;
  editorReady: boolean;
  loadError: string | null;
  handlePublish: (data: PublishData) => Promise<void>;
  handleSchedule: (data: PublishData, scheduledAt: string) => Promise<void>;
}

/** Said when a paywalled piece's paid half could not be read for editing. */
export const PAID_HALF_UNAVAILABLE =
  "This article's paid section could not be loaded, so it can't be edited right now. Nothing has changed. Try again in a moment.";

/** True when the editor's target needs no network round-trip: a note→article
 *  seed and nothing else. An edit or a draft always loads. */
function seedIsSynchronous(
  editEventId: string | null,
  draftId: string | null,
  seedContent: string | null | undefined,
): boolean {
  return !editEventId && !draftId && seedContent != null;
}

/** The seeded target's initial data. One definition, shared by the state
 *  initialisers, the render-phase reset and the load effect, so the three can't
 *  disagree about what a seeded editor opens with. */
function seedData(
  seedContent: string | null | undefined,
  seedTitle: string | null | undefined,
): ArticleEditorInitialData {
  return {
    title: seedTitle ?? "",
    dek: "",
    content: seedContent ?? "",
    gatePosition: 50,
    price: 0,
    commentsEnabled: true,
  };
}

export function useArticleEditorInit({
  editEventId,
  draftId,
  pubSlug,
  seedContent = null,
  seedTitle = null,
  onComplete,
}: UseArticleEditorInitOpts): ArticleEditorInit {
  const { user } = useAuth();

  // A SEED NEEDS NO I/O, SO IT MUST NOT WAIT FOR ANY. The note→article handoff
  // carries its whole payload in the caller's arguments — there is nothing to
  // fetch — yet it used to sit behind the same async effect as the edit/draft
  // loads, so the editor's first painted frame was the "Loading…" placeholder
  // and the real editor arrived a commit later. That pause is the visible half
  // of "the pane takes a moment to collect itself" during the handoff. Seeded
  // opens are therefore resolved in the INITIALISER (and in the render-phase
  // reset below), so `editorReady` is true on the very first render and the
  // pane that grows out of the note composer already has the editor in it.
  const [editorReady, setEditorReady] = useState(() =>
    seedIsSynchronous(editEventId, draftId, seedContent),
  );
  const [initialData, setInitialData] = useState<ArticleEditorInitialData | null>(
    () =>
      seedIsSynchronous(editEventId, draftId, seedContent)
        ? seedData(seedContent, seedTitle)
        : null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pubMemberships, setPubMemberships] = useState<PublicationContext[]>([]);
  const [initialPubId, setInitialPubId] = useState<string | null>(null);

  // The EditorOverlay mounts this hook globally and reuses it across opens, so
  // a previous open's state (editorReady=true, a stale initialData) would
  // otherwise leak into the next target's first render — ArticleEditor reads
  // its initial* props only at mount, so it would mount empty before the load
  // effect runs and then ignore the data (the note→article seed-loss bug).
  // Reset synchronously when the load target changes (render-phase derived
  // state) so the caller's !editorReady gate holds until the target is loaded.
  const loadKey = JSON.stringify([editEventId, draftId, seedContent, seedTitle]);
  // The key the editor is CURRENTLY waiting for, readable from inside an
  // in-flight load. A ref rather than the state value, because the async
  // closure captured its own `loadKey` at the moment it started — comparing
  // that against a captured copy would always agree.
  const loadKeyRef = useRef(loadKey);
  loadKeyRef.current = loadKey;
  const [prevLoadKey, setPrevLoadKey] = useState(loadKey);
  if (prevLoadKey !== loadKey) {
    setPrevLoadKey(loadKey);
    setEditorReady(seedIsSynchronous(editEventId, draftId, seedContent));
    setInitialData(
      seedIsSynchronous(editEventId, draftId, seedContent)
        ? seedData(seedContent, seedTitle)
        : null,
    );
    setLoadError(null);
  }

  // Load publication memberships. Skipped while publications are suspended
  // (lib/featureFlags.ts) — this is the ONE choke point for the editor's whole
  // publication affordance: ArticleEditor renders its publication selector only
  // when `publicationMemberships.length > 0`, so an empty list hides the
  // selector, and with nothing selectable `data.publicationId` stays null and
  // the publish/schedule paths below take their personal branches. No second
  // gate in the component, and no half-lit state where the selector shows a
  // title the gateway will refuse.
  useEffect(() => {
    if (!user || !publicationsEnabled()) return;
    publicationsApi
      .myMemberships()
      .then((res) => {
        const ctx: PublicationContext[] = res.publications.map((p) => ({
          id: p.id,
          slug: p.slug,
          name: p.name,
          can_publish: p.can_publish,
        }));
        setPubMemberships(ctx);
        if (pubSlug) {
          const match = ctx.find((p) => p.slug === pubSlug);
          if (match) setInitialPubId(match.id);
        }
      })
      .catch(() => {
        /* non-critical */
      });
  }, [user, pubSlug]);

  // Load edit or draft data (or seed from a note)
  //
  // A CANCEL FLAG, BECAUSE THE TARGET CAN CHANGE IN PLACE AND THE LOSER WINS.
  // Everything this effect resolves lands in `initialData`, and
  // `initialData.editingDTag` is what `publishArticle` republishes UNDER — so
  // a resolve that arrives after the writer has moved on does not merely show
  // the wrong thing, it retargets the next Publish. Driven shape: Edit article
  // X from the dashboard, Escape before the two fetches resolve, ⌘K, write a
  // note, "Make this an article" — the seeded editor mounts SYNCHRONOUSLY
  // (`editorReady` is true in the initialiser), X's fetch then resolves into
  // the mounted editor, and Publish puts the new piece out over X's d-tag,
  // replacing a published article with a different one.
  //
  // Two guards rather than one, because each closes a different half: the
  // `cancelled` flag stops a resolve after unmount/re-run, and the `loadKey`
  // compare stops a resolve whose request belongs to a target that is no
  // longer the one being edited (the key is the same one the render-phase
  // reset above keys on, so the two cannot disagree). The rule is
  // `.claude/rules/web-overlays.md`'s own — "ReplySection needs its cancel
  // flag for exactly this reason, a target that can change in place".
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const startedFor = loadKey;
    /** True while this run is still the one the editor is waiting for. */
    const current = () => !cancelled && startedFor === loadKeyRef.current;

    async function loadEditData() {
      if (editEventId) {
        try {
          // Only a 404 is an absence; any other failure falls to the catch
          // below, which says the load failed rather than that nothing is there.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const meta = await request<any>(`/articles/by-event/${editEventId}`).catch(
            (err: unknown) => {
              if (err instanceof ApiError && err.status === 404) return null;
              throw err;
            },
          );
          if (!meta) {
            if (current()) setLoadError("Couldn’t find that article. It may have been deleted, or the link may be wrong.");
            return;
          }

          // A PAID PIECE WITHOUT ITS PAID HALF IS NOT EDITABLE. The route
          // fetches the paid half from the key service "non-fatal" and answers
          // `contentPaywall: null` when it could not, so opening the editor on
          // the free half alone loads a body with no gate marker — and the next
          // Publish puts the piece out FREE, its paid half gone. Refuse to open
          // instead; the modernhaus register does the same
          // (`loadEdit`'s `paid_half_unavailable`, MODERNHAUS-ADR §E4.2.8).
          if (meta.isPaywalled && !meta.contentPaywall) {
            if (current()) setLoadError(PAID_HALF_UNAVAILABLE);
            return;
          }

          let existingTags: string[] = [];
          if (meta.id) {
            try {
              existingTags = (await tagsApi.getForArticle(meta.id)).tags;
            } catch {
              /* non-fatal */
            }
          }

          let content = meta.contentFree ?? "";
          if (meta.contentPaywall) {
            content = `${meta.contentFree ?? ""}\n\n<!-- paywall-gate -->\n\n${meta.contentPaywall}`;
          }

          if (current()) setInitialData({
            title: meta.title ?? "",
            dek: meta.summary ?? "",
            content,
            gatePosition: meta.gatePositionPct ?? 50,
            price: meta.pricePence ?? 0,
            commentsEnabled: meta.commentsEnabled ?? true,
            tags: existingTags,
            editingEventId: editEventId,
            editingDTag: meta.dTag ?? "",
            coverImageUrl: meta.coverImageUrl ?? null,
          });
        } catch (err) {
          console.error("Failed to load article for editing:", err);
          if (current()) setLoadError("Couldn’t load this article for editing. Please try again.");
        }
      } else if (draftId) {
        try {
          const draft = await loadDraft(draftId);
          // Absent and broken are different facts and get different words: a
          // writer told "not found" about a draft the gateway merely could not
          // be asked about has been told their work is gone.
          if (draft === undefined) {
            if (current()) setLoadError("Couldn’t load that draft. Please try again.");
            return;
          }
          if (draft === null) {
            if (current()) setLoadError("That draft doesn’t exist, or it isn’t yours.");
            return;
          }
          if (current()) setInitialData({
            title: draft.title ?? "",
            dek: draft.dek ?? "",
            content: draft.content ?? "",
            gatePosition: draft.gatePositionPct ?? 50,
            price: draft.pricePence ?? 0,
            commentsEnabled: draft.commentsEnabled ?? true,
            draftId,
            editingDTag: draft.dTag ?? undefined,
            coverImageUrl: draft.coverImageUrl ?? null,
          });
        } catch {
          if (current()) setLoadError("Couldn’t load that draft. Please try again.");
        }
      } else if (seedContent != null) {
        // Note→article escalation. Already resolved synchronously above — this
        // re-set is the same value and exists so the branch isn't a silent hole
        // if the initialiser's condition ever narrows.
        if (current()) setInitialData(seedData(seedContent, seedTitle));
      } else {
        // New article — no initial data needed
        if (current()) setInitialData(null);
      }
      if (current()) setEditorReady(true);
    }

    void loadEditData();
    return () => {
      cancelled = true;
    };
  }, [user, editEventId, draftId, seedContent, seedTitle, loadKey]);

  // Best-effort: the article is safely out the door; a surviving draft row is
  // cosmetic (the old "draft + published, both in the dashboard" bug), so a
  // cleanup failure must never surface as a publish error.
  async function cleanUpDraft(draftId: string | null | undefined) {
    if (!draftId) return;
    try {
      await deleteDraft(draftId);
    } catch {
      /* best-effort */
    }
  }

  // `initialData?.editingDTag` IS THE REPUBLISH TARGET, read live at the press
  // — here and in `handleSchedule` below, which passes the same value to
  // `saveDraft`. That is what makes the load effect's cancel flag a
  // correctness guard rather than a tidiness one: a stale resolve landing in
  // `initialData` does not show the wrong thing, it retargets the next
  // Publish onto another article's d-tag. Both paths are covered by the one
  // fix, because both read the same field.
  async function handlePublish(data: PublishData) {
    if (!user) return;

    if (data.publicationId) {
      const result = await publishToPublication(
        data.publicationId,
        { ...data, showOnWriterProfile: data.showOnWriterProfile },
        initialData?.editingDTag,
      );
      // A submission that lands in review keeps its draft — the pending
      // article isn't the writer's editable copy yet.
      if (result.status === "published") await cleanUpDraft(data.draftId);
      const pub = pubMemberships.find((p) => p.id === data.publicationId);
      onComplete({ overlay: "dashboard", context: pub?.slug ?? "", tab: "articles" });
    } else {
      await publishArticle(data, user.pubkey, initialData?.editingDTag);
      await cleanUpDraft(data.draftId);
      onComplete({ overlay: "dashboard", tab: "articles" });
    }
  }

  async function handleSchedule(data: PublishData, scheduledAt: string) {
    if (!user) return;

    // Reassemble the gate marker whenever the article is paywalled. freeContent
    // is legitimately empty when the gate sits at the very top, so gating the
    // reassembly on `data.freeContent` (the old bug) dropped the marker and fell
    // back to data.content — the marker-stripped body — publishing the entire
    // paid section as a free public article. Validation guarantees paywallContent
    // is non-empty by this point.
    const content = data.isPaywalled
      ? `${data.freeContent}\n\n<!-- paywall-gate -->\n\n${data.paywallContent}`
      : data.content;
    const saved = await saveDraft({
      title: data.title,
      dek: data.dek,
      content,
      gatePositionPct: data.gatePositionPct,
      pricePence: data.pricePence,
      draftId: data.draftId ?? undefined,
      dTag: initialData?.editingDTag,
      // Never let the gateway guess a row for the piece being scheduled — its
      // guess is the writer's most recent untagged draft, which may be another
      // piece. The editor flushes onto its own row first, so this is the floor.
      newDraft: !data.draftId && !initialData?.editingDTag ? true : undefined,
      coverImageUrl: data.coverImageUrl ?? null,
      // Without this a scheduled publication article publishes to the personal
      // profile (wrong byline/surface, bypassing review + splits) — the field is
      // plumbed end-to-end (drafts schema → scheduler branches on publication_id).
      publicationId: data.publicationId ?? undefined,
      // Carry the reply toggle so a scheduled article keeps its comments setting
      // (M19); dek (above) keeps the standfirst + NIP-23 summary tag (M20).
      commentsEnabled: data.commentsEnabled,
    });

    await scheduleDraft(saved.draftId, scheduledAt);
    onComplete({ overlay: "dashboard", tab: "articles" });
  }

  return {
    initialData,
    pubMemberships,
    initialPubId,
    editorReady,
    loadError,
    handlePublish,
    handleSchedule,
  };
}
