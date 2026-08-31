import type { PublishData } from "../components/editor/ArticleEditor";

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

const API_BASE = "/api/v1";

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
}

export interface SavedDraft {
  draftId: string;
  autoSavedAt: string;
  scheduledAt: string | null;
}

export async function saveDraft(data: DraftData): Promise<SavedDraft> {
  const res = await fetch(`${API_BASE}/drafts`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      `Draft save failed: ${res.status} — ${body?.error ?? "unknown"}`,
    );
  }

  return res.json();
}

export async function loadDrafts(): Promise<SavedDraft[]> {
  const res = await fetch(`${API_BASE}/drafts`, {
    credentials: "include",
  });

  if (!res.ok) return [];
  const data = await res.json();
  return data.drafts ?? [];
}

export async function loadDraft(draftId: string): Promise<DraftData | null> {
  const res = await fetch(`${API_BASE}/drafts/${draftId}`, {
    credentials: "include",
  });

  if (!res.ok) return null;
  return res.json();
}

export async function deleteDraft(draftId: string): Promise<void> {
  await fetch(`${API_BASE}/drafts/${draftId}`, {
    method: "DELETE",
    credentials: "include",
  });
}

export async function scheduleDraft(
  draftId: string,
  scheduledAt: string,
): Promise<{ ok: boolean; scheduledAt: string }> {
  const res = await fetch(`${API_BASE}/drafts/${draftId}/schedule`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scheduledAt }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      `Schedule failed: ${res.status} — ${body?.error ?? "unknown"}`,
    );
  }

  return res.json();
}

export async function unscheduleDraft(draftId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/drafts/${draftId}/schedule`, {
    method: "DELETE",
    credentials: "include",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      `Unschedule failed: ${res.status} — ${body?.error ?? "unknown"}`,
    );
  }
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

export function createAutoSaver(delayMs = 3000) {
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
        const result = await saveDraft(data);
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
