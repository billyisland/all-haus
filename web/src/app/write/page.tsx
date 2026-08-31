"use client";

import { useAuth } from "../../stores/auth";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import dynamic from "next/dynamic";

const ArticleEditor = dynamic(
  () =>
    import("../../components/editor/ArticleEditor").then(
      (m) => m.ArticleEditor,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="mx-auto max-w-article px-4 sm:px-6 pt-16 pb-16 lg:pt-8 text-center">
        <div className="h-8 w-48 mx-auto animate-pulse rounded bg-grey-100" />
        <p className="mt-4 text-sm text-grey-300">Loading editor...</p>
      </div>
    ),
  },
);
import { useArticleEditorInit } from "../../hooks/useArticleEditorInit";

// =============================================================================
// Write Page — the standalone, addressable full-page article editor (kept for
// direct visits / bookmarks / deep-links alongside the workspace EditorOverlay,
// which renders the same ArticleEditor in a Glasshouse). Data-loading and
// publish/schedule logic live in the shared useArticleEditorInit hook so the
// two surfaces can't drift.
//
// Three modes:
//   1. New article: /write (no params)
//   2. Edit published article: /write?edit=<nostrEventId>
//   3. Continue draft: /write?draft=<draftId>
// =============================================================================

export default function WritePage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const editEventId = searchParams.get("edit");
  const draftId = searchParams.get("draft");
  const pubSlug = searchParams.get("pub");

  useEffect(() => {
    if (!loading && !user) {
      router.push("/auth?mode=login");
    }
  }, [user, loading, router]);

  const {
    initialData,
    pubMemberships,
    initialPubId,
    editorReady,
    loadError,
    handlePublish,
    handleSchedule,
  } = useArticleEditorInit({
    editEventId,
    draftId,
    pubSlug,
    // Standalone page navigates the route; the overlay closes itself instead.
    onComplete: (dest) => {
      const params = new URLSearchParams({ overlay: dest.overlay });
      if (dest.tab) params.set("tab", dest.tab);
      if (dest.context) params.set("context", dest.context);
      router.push(`/reader?${params.toString()}`);
    },
  });

  if (loading || !user) {
    return (
      <div className="mx-auto max-w-article px-4 sm:px-6 pt-16 pb-16 lg:pt-8 text-center">
        <div className="h-8 w-48 mx-auto animate-pulse rounded bg-grey-100" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-article px-4 sm:px-6 pt-16 pb-16 lg:pt-8 text-center">
        <p className="text-red-600 mb-4">{loadError}</p>
        <a
          href="/reader?overlay=dashboard"
          className="text-sm text-crimson hover:text-crimson-dark"
        >
          Back to dashboard
        </a>
      </div>
    );
  }

  if ((editEventId || draftId) && !editorReady) {
    return (
      <div className="mx-auto max-w-article px-4 sm:px-6 pt-16 pb-16 lg:pt-8 text-center">
        <div className="h-8 w-48 mx-auto animate-pulse rounded bg-grey-100" />
        <p className="mt-4 text-sm text-grey-300">Loading...</p>
      </div>
    );
  }

  return (
    <ArticleEditor
      initialTitle={initialData?.title}
      initialDek={initialData?.dek}
      initialContent={initialData?.content}
      initialGatePosition={initialData?.gatePosition}
      initialPrice={initialData?.price}
      initialCommentsEnabled={initialData?.commentsEnabled}
      initialTags={initialData?.tags}
      initialCoverImageUrl={initialData?.coverImageUrl ?? null}
      initialDraftId={initialData?.draftId ?? null}
      editingEventId={initialData?.editingEventId}
      editingDTag={initialData?.editingDTag}
      publicationMemberships={pubMemberships}
      initialPublicationId={initialPubId}
      onPublish={handlePublish}
      onSchedule={!editEventId ? handleSchedule : undefined}
    />
  );
}
