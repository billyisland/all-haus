import { create } from "zustand";

// =============================================================================
// useEditorOverlay — the single article-writing surface, the full ArticleEditor
// wrapped in a workspace Glasshouse (EditorOverlay). Mounted globally in
// LayoutShell (like ProfileOverlay) so "write an article" is reachable from the
// workspace, the dashboard overlay, and the note→article handoff alike.
//
// In-memory only (like the dashboard/messages overlays): pushes no shareable
// URL. Deep links arrive as /reader?overlay=editor[&draft|&edit|&pub] and are
// dispatched by lib/workspace/overlays.ts → open() with the seeded ids. The
// standalone /write page remains the addressable full-page editor.
// =============================================================================

interface EditorOverlayState {
  isOpen: boolean;
  draftId: string | null;
  editEventId: string | null;
  publicationSlug: string | null;
  /** Note→article seed: carried body + (heading-promoted) title. */
  initialContent: string | null;
  initialTitle: string | null;
  open: (opts?: {
    draftId?: string | null;
    editEventId?: string | null;
    publicationSlug?: string | null;
    initialContent?: string | null;
    initialTitle?: string | null;
  }) => void;
  close: () => void;
}

export const useEditorOverlay = create<EditorOverlayState>((set) => ({
  isOpen: false,
  draftId: null,
  editEventId: null,
  publicationSlug: null,
  initialContent: null,
  initialTitle: null,
  open: (opts) =>
    set({
      isOpen: true,
      draftId: opts?.draftId ?? null,
      editEventId: opts?.editEventId ?? null,
      publicationSlug: opts?.publicationSlug ?? null,
      initialContent: opts?.initialContent ?? null,
      initialTitle: opts?.initialTitle ?? null,
    }),
  close: () =>
    set({
      isOpen: false,
      draftId: null,
      editEventId: null,
      publicationSlug: null,
      initialContent: null,
      initialTitle: null,
    }),
}));

// Note→article elevation: a heading-prefixed first line is promoted to the
// title, the rest becomes the body (Wireframe Step 6). Lifted verbatim from the
// workspace Composer's old switchToArticle so the one-way escalation behaves
// identically now that the editor lives in its own overlay.
export function seedFromNote(body: string): {
  initialTitle: string;
  initialContent: string;
} {
  const trimmed = body.trimStart();
  const m = trimmed.match(/^#{1,3}\s+(.+?)\s*\n([\s\S]*)$/);
  if (m) return { initialTitle: m[1].trim(), initialContent: m[2].trimStart() };
  return { initialTitle: "", initialContent: body };
}
