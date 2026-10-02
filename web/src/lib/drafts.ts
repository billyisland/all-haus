import type { PublishData } from "../components/editor/ArticleEditor";
import { ApiError, request } from "./api/client";

// =============================================================================
// Draft Saving
//
// Per ADR: "NIP-23 defines draft event kind 30024. Auto-save behaviour,
// local vs relay storage, crash recovery — implementation details to be
// resolved."
//
// At launch, drafts are saved to the platform database (article_drafts table)
// via the gateway API. Auto-save fires 3 seconds after the last edit.
// Relay-side draft events (kind 30024) are a post-launch addition.
// =============================================================================

export interface DraftData {
  title: string;
  dek?: string; // optional standfirst/subtitle
  content: string; // full raw editor content
  gatePositionPct: number;
  pricePence: number;
  draftId?: string; // echo of a previous save's draftId — pins saves to that exact row
  dTag?: string; // set when editing an existing article
  coverImageUrl?: string | null;
  publicationId?: string | null;
  commentsEnabled?: boolean; // "allow replies" toggle
  // Mint a row of its own rather than let the gateway guess. Without an id or a
  // dTag, `POST /drafts` updates the writer's most recent untagged draft, which
  // is an unrelated piece whenever one exists. Set only by `createDraftTargeter`.
  newDraft?: true;
}

export interface SavedDraft {
  draftId: string;
  autoSavedAt: string;
  scheduledAt: string | null;
}

// Every call below goes through `request()`: a refusal is an `ApiError`
// carrying the route's status and body, which a surface words with
// `failureSentence` (lib/api/client) — never a hand-built "Draft save failed:
// 500" string (CA-J2).
export function saveDraft(data: DraftData): Promise<SavedDraft> {
  return request<SavedDraft>("/drafts", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// An outage is not an empty drawer. This used to answer any non-ok response
// with `[]`, so a dead gateway showed the dashboard's content list with the
// member's drafts silently missing — and, being an ordinary render, the list's
// own error branch never fired. A writer looking for something they had saved
// and not yet published would have been told, by omission, that it was gone.
export async function loadDrafts(): Promise<SavedDraft[]> {
  const data = await request<{ drafts?: SavedDraft[] }>("/drafts");
  return data?.drafts ?? [];
}

/**
 * What `GET /drafts/:id` actually returns — `DraftData` plus the row's own
 * bookkeeping. The route is WRITER-SCOPED on the session cookie, so it carries
 * no writer identity: a caller that needs one takes it from `useAuth()`, which
 * is the same person by construction.
 */
export interface LoadedDraft extends DraftData {
  draftId: string;
  autoSavedAt: string;
  scheduledAt: string | null;
}

/**
 * A single draft, or null.
 *
 * THREE STATES, NOT TWO (the outage rule): `undefined` is an outage — the
 * gateway could not be reached or answered 5xx — while `null` is a definitive
 * "no such draft of yours". A caller that folds them together tells a writer
 * their work is gone when the gateway merely blinked.
 */
export async function loadDraft(
  draftId: string,
): Promise<LoadedDraft | null | undefined> {
  try {
    return await request<LoadedDraft>(`/drafts/${draftId}`);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 401 || err.status === 403)) {
      return null;
    }
    return undefined;
  }
}

// A DELETE THAT ANSWERED 4xx/5xx IS NOT A DELETE (CA-E3). This awaited the
// fetch and never read `res.ok`, so the dashboard filtered the row out on a
// refusal and the draft came back on the next load, with `DRAFT_DELETE_FAILED`
// reserved for a network throw alone. `request()` throws on any non-2xx. The
// only other caller (`cleanUpDraft` in `useArticleEditorInit`) is best-effort
// inside its own try/catch, so the throw reaches nothing that cannot take it.
export async function deleteDraft(draftId: string): Promise<void> {
  await request<unknown>(`/drafts/${draftId}`, { method: "DELETE" });
}

// A refusal a writer can act on ("set a price", "give it a title") is the
// route's `message`, which `failureSentence` shows as written.
export function scheduleDraft(
  draftId: string,
  scheduledAt: string,
): Promise<{ ok: boolean; scheduledAt: string }> {
  return request(`/drafts/${draftId}/schedule`, {
    method: "POST",
    body: JSON.stringify({ scheduledAt }),
  });
}

export async function unscheduleDraft(draftId: string): Promise<void> {
  await request<unknown>(`/drafts/${draftId}/schedule`, { method: "DELETE" });
}

// =============================================================================
// Auto-save hook helper
//
// Usage in the editor:
//   const debouncedSave = createAutoSaver()
//   // In editor's onUpdate:
//   debouncedSave({ title, content, gatePositionPct, pricePence })
// =============================================================================

function fingerprintOf(data: DraftData): string {
  return [
    data.title ?? "",
    data.content ?? "",
    data.dek ?? "",
    data.pricePence ?? "",
    data.gatePositionPct ?? "",
    data.coverImageUrl ?? "",
    data.commentsEnabled ?? "",
  ].join("|");
}

export function createAutoSaver(
  delayMs = 3000,
  save: (data: DraftData) => Promise<SavedDraft> = saveDraft,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSavedContent = "";

  function debouncedSave(
    data: DraftData,
    onSaved?: (draft: SavedDraft) => void,
    onError?: (err: Error) => void,
  ) {
    if (timer) clearTimeout(timer);

    timer = setTimeout(async () => {
      // Fingerprint covers every persisted field (M21): keying on title|content
      // alone meant a dek / price / cover / comments-only change never saved.
      const fingerprint = fingerprintOf(data);
      if (fingerprint === lastSavedContent) return;

      try {
        const result = await save(data);
        lastSavedContent = fingerprint;
        onSaved?.(result);
      } catch (err) {
        onError?.(err as Error);
      }
    }, delayMs);
  }

  debouncedSave.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  // Whether `data` differs from the last successful save — lets a caller decide
  // to flush on close without risking a redundant write.
  debouncedSave.isDirty = (data: DraftData) => fingerprintOf(data) !== lastSavedContent;
  // Record a save made outside the debounce (an explicit Save) so the next
  // autosave/flush doesn't re-persist identical content.
  debouncedSave.markSaved = (data: DraftData) => {
    lastSavedContent = fingerprintOf(data);
  };

  return debouncedSave;
}

// =============================================================================
// createDraftTargeter — one piece, one row, from its FIRST save.
//
// A save carrying no draftId and no dTag used to let `POST /drafts` guess, and
// the guess is "the writer's most recent untagged, unscheduled draft": a new
// piece's first autosave overwrote an unrelated draft's title and body whenever
// one existed. The guess was there to stop the first autosave and an explicit
// Save racing into two rows. So the first save now asks for a row of its own
// (`newDraft`), and the race is closed HERE instead: every save that still has
// no id while the first is in flight waits for it and targets the row it made.
// A first save that FAILS mints nothing, so the next one tries again.
// =============================================================================

export function createDraftTargeter(
  save: (data: DraftData) => Promise<SavedDraft> = saveDraft,
) {
  let first: Promise<SavedDraft> | null = null;

  return async function saveTargeted(data: DraftData): Promise<SavedDraft> {
    if (data.draftId || data.dTag) return save(data);
    for (;;) {
      const pending = first;
      if (!pending) break;
      const made = await pending.catch(() => null);
      if (made) return save({ ...data, draftId: made.draftId });
      if (first === pending) first = null;
    }
    // Synchronous from the loop's last check to here, so a second caller
    // resuming after us sees this promise and waits on it.
    const mine = save({ ...data, newDraft: true });
    first = mine;
    return mine;
  };
}
