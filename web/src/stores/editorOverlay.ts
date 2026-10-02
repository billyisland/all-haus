import { create } from "zustand";
import {
  appendNoteImages,
  noteTextToMarkdown,
  type NoteSeedAttachment,
} from "../lib/note-seed";
import type { PaneRect } from "../components/workspace/paneRect";

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
  /** One-shot: the box the pane this one REPLACES was occupying, so the editor
   *  grows out of it instead of cutting to its own geometry (see Glasshouse's
   *  `enterFrom`). Null for every other way the editor opens. */
  enterFrom: PaneRect | null;
  open: (opts?: {
    draftId?: string | null;
    editEventId?: string | null;
    publicationSlug?: string | null;
    initialContent?: string | null;
    initialTitle?: string | null;
    enterFrom?: PaneRect | null;
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
  enterFrom: null,
  open: (opts) =>
    set({
      isOpen: true,
      draftId: opts?.draftId ?? null,
      editEventId: opts?.editEventId ?? null,
      publicationSlug: opts?.publicationSlug ?? null,
      initialContent: opts?.initialContent ?? null,
      initialTitle: opts?.initialTitle ?? null,
      enterFrom: opts?.enterFrom ?? null,
    }),
  close: () =>
    set({
      isOpen: false,
      draftId: null,
      editEventId: null,
      publicationSlug: null,
      initialContent: null,
      initialTitle: null,
      enterFrom: null,
    }),
}));

// Note→article elevation: a heading-prefixed first line is promoted to the
// title, the rest becomes the body (Wireframe Step 6). Lifted from the
// workspace Composer's old switchToArticle so the one-way escalation behaves
// identically now that the editor lives in its own overlay.
//
// THE HANDOFF CARRIES WHAT THE NOTE BOX WAS SHOWING, not just its string. A
// textarea's newlines are visible line breaks in a published note
// (`whitespace-pre-wrap`) and a SPACE in the editor's markdown, and an attached
// image is an uploaded blob the note surface holds outside the text entirely —
// so both are converted here (lib/note-seed.ts). Dropping either is silent:
// the writer arrives in the editor with their lines welded into one paragraph
// and their pictures gone, and nothing anywhere said so.
export function seedFromNote(
  body: string,
  attachments: NoteSeedAttachment[] = [],
): {
  initialTitle: string;
  initialContent: string;
} {
  const trimmed = body.trimStart();
  const m = trimmed.match(/^#{1,3}\s+(.+?)\s*\n([\s\S]*)$/);
  const title = m ? m[1].trim() : "";
  const rest = m ? m[2].trimStart() : body;
  return {
    initialTitle: title,
    initialContent: appendNoteImages(noteTextToMarkdown(rest), attachments),
  };
}
