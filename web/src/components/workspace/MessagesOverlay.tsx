"use client";

// =============================================================================
// MessagesOverlay — the merged Messages surface in a workspace Glasshouse:
// notifications log + direct messages in one three-column inbox (MessagesInbox).
// Mounted once in WorkspaceView; opened from the single ForallMenu "Messages"
// row via useMessagesOverlay, or via /reader?overlay=messages[&conversation]
// and the retired /messages + /notifications routes (both redirect here). The
// ForallMenu stays crisp above the frost.
// =============================================================================

import { useMessagesOverlay } from "../../stores/messagesOverlay";
import { Glasshouse } from "./Glasshouse";
import { MessagesInbox } from "../messages/MessagesInbox";

export function MessagesOverlay() {
  const { isOpen, conversationId, close } = useMessagesOverlay();
  if (!isOpen) return null;

  // Wide default to seat the three columns; `resizable` lets it stretch beyond.
  // The inbox sizes its own scroll region against the pane height (--gh-h).
  return (
    <Glasshouse
      onClose={close}
      maxWidth={1180}
      ariaLabel="Messages"
      persistKey="messages"
      resizable
    >
      <MessagesInbox
        className="h-[var(--gh-h)] min-h-[420px]"
        initialConversationId={conversationId}
      />
    </Glasshouse>
  );
}
