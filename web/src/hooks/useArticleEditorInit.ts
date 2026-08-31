"use client";

import { useEffect, useState } from "react";
import { useAuth } from "../stores/auth";
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

export function useArticleEditorInit({
  editEventId,
  draftId,
  pubSlug,
  seedContent = null,
  seedTitle = null,
  onComplete,
}: UseArticleEditorInitOpts): ArticleEditorInit {
  const { user } = useAuth();

  const [editorReady, setEditorReady] = useState(false);
  const [initialData, setInitialData] =
    useState<ArticleEditorInitialData | null>(null);
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
  const [prevLoadKey, setPrevLoadKey] = useState(loadKey);
  if (prevLoadKey !== loadKey) {
    setPrevLoadKey(loadKey);
    setEditorReady(false);
    setInitialData(null);
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
  useEffect(() => {
    if (!user) return;

    async function loadEditData() {
      if (editEventId) {
        try {
          const res = await fetch(`/api/v1/articles/by-event/${editEventId}`, {
            credentials: "include",
          });
          if (!res.ok) {
            setLoadError("Could not find the article to edit.");
            return;
          }
          const meta = await res.json();

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

          setInitialData({
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
          setLoadError("Failed to load article for editing.");
        }
      } else if (draftId) {
        try {
          const draft = await loadDraft(draftId);
          if (!draft) {
            setLoadError("Draft not found.");
            return;
          }
          setInitialData({
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
          setLoadError("Failed to load draft.");
        }
      } else if (seedContent != null) {
        // Note→article escalation: seed the body (+ promoted title).
        setInitialData({
          title: seedTitle ?? "",
          dek: "",
          content: seedContent,
          gatePosition: 50,
          price: 0,
          commentsEnabled: true,
        });
      } else {
        // New article — no initial data needed
        setInitialData(null);
      }
      setEditorReady(true);
    }

    void loadEditData();
  }, [user, editEventId, draftId, seedContent, seedTitle]);

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
