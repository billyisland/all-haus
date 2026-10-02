"use client";

// =============================================================================
// EditorOverlay — the single article-writing surface: the full ArticleEditor in
// a workspace Glasshouse. Mounted globally in LayoutShell (like ProfileOverlay)
// so "write an article" is reachable from the workspace, the dashboard overlay,
// and the note→article handoff. Opened via useEditorOverlay (ForallMenu, the
// dashboard "New article"/"Edit" rows, the compose "Make this an article →"
// button)
// or the /reader?overlay=editor deep-link. The standalone /write page remains
// the addressable full-page editor for direct visits/bookmarks.
// =============================================================================

import { useRouter } from "next/navigation";
import { useEditorOverlay } from "../../stores/editorOverlay";
import { useArticleEditorInit } from "../../hooks/useArticleEditorInit";
import { Glasshouse } from "./Glasshouse";
import { ArticleEditor } from "../editor/ArticleEditor";
import { WriterAccessPanel } from "../writer/WriterAccessPanel";
import { useAuth } from "../../stores/auth";

export function EditorOverlay() {
  const router = useRouter();
  const {
    isOpen,
    draftId,
    editEventId,
    publicationSlug,
    initialContent,
    initialTitle,
    enterFrom,
    close,
  } = useEditorOverlay();

  // Hooks must run unconditionally; the render bails below when closed. The load
  // effects no-op while there's no user / nothing seeded.
  const init = useArticleEditorInit({
    editEventId,
    draftId,
    pubSlug: publicationSlug,
    seedContent: initialContent,
    seedTitle: initialTitle,
    // Post-publish: close the editor and land on the dashboard's articles tab.
    // Routed through the URL rather than the dashboard store directly because
    // DashboardOverlay is mounted in WorkspaceView while this overlay is global
    // — a router.push works from any surface, mirroring the old /write flow.
    onComplete: (dest) => {
      close();
      const params = new URLSearchParams({ overlay: dest.overlay });
      if (dest.tab) params.set("tab", dest.tab);
      if (dest.context) params.set("context", dest.context);
      router.push(`/reader?${params.toString()}`);
    },
  });

  const canWrite = useAuth((s) => s.user?.canWrite === true);

  if (!isOpen) return null;

  // A READER has no editor (READER-WRITER-SPLIT-ADR §6.2): every opener is
  // gated, so what reaches here is a `?overlay=editor` deep link, and it gets
  // the one explanation rather than a surface whose every press is refused.
  if (!canWrite) {
    return (
      <Glasshouse onClose={close} maxWidth={640} ariaLabel="Writing articles">
        <div className="overflow-y-auto max-h-[var(--gh-h)] px-6 sm:px-10 py-12">
          <WriterAccessPanel />
        </div>
      </Glasshouse>
    );
  }

  return (
    // The editor is the SECOND immersive pane (the reader is the first): writing
    // a piece fills the whole of your attention exactly as reading one does, so
    // it takes `coverNavChrome` + `fillHeight` and WorkspaceView un-mounts the
    // bar + muster while it is open (a pane that covers the bar while the bar
    // still paints puts the bar on top of the pane). `maxWidth` is the reader's
    // own native-article width, so the two panes are one geometry — the editor's
    // document column is capped at `max-w-article` inside it, which is what
    // makes the extra width air around the same column rather than a wider
    // measure than readers will ever see. `persistKey`/`resizable` unchanged: a
    // remembered resized height still beats both defaults.
    <Glasshouse
      onClose={close}
      maxWidth={1000}
      ariaLabel="Write an article"
      persistKey="editor"
      // Set only by the note→article handoff: the pane grows out of the note
      // composer's box instead of cutting to its own geometry, so the two
      // surfaces read as one window changing shape. Null on every other open.
      enterFrom={enterFrom}
      resizable
      fillHeight
      coverNavChrome
    >
      <div className="flex flex-col h-full max-h-[var(--gh-h)] overflow-y-auto">
        {init.loadError ? (
          <div className="px-6 sm:px-10 py-12 text-center">
            <p className="text-red-600">{init.loadError}</p>
          </div>
        ) : !init.editorReady ? (
          // Gate on readiness for EVERY target (edit/draft loads AND the
          // note→article seed): ArticleEditor reads its initial* props only at
          // mount, so mounting it before the init effect has populated
          // initialData permanently drops the target's content.
          <div className="px-6 sm:px-10 py-12 text-center">
            <div className="h-8 w-48 mx-auto animate-pulse rounded bg-grey-100" />
            <p className="mt-4 text-sm text-grey-600">Loading…</p>
          </div>
        ) : (
          <ArticleEditor
            chrome="overlay"
            initialTitle={init.initialData?.title}
            initialDek={init.initialData?.dek}
            initialContent={init.initialData?.content}
            initialGatePosition={init.initialData?.gatePosition}
            initialPrice={init.initialData?.price}
            initialCommentsEnabled={init.initialData?.commentsEnabled}
            initialTags={init.initialData?.tags}
            initialCoverImageUrl={init.initialData?.coverImageUrl ?? null}
            initialDraftId={init.initialData?.draftId ?? null}
            editingEventId={init.initialData?.editingEventId}
            editingDTag={init.initialData?.editingDTag}
            publicationMemberships={init.pubMemberships}
            initialPublicationId={init.initialPubId}
            onPublish={init.handlePublish}
            onSchedule={!editEventId ? init.handleSchedule : undefined}
          />
        )}
      </div>
    </Glasshouse>
  );
}
