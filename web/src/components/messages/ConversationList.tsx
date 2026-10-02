"use client";

import { type Conversation } from "../../lib/api";
import { timeAgo } from "../../lib/format";
import {
  MESSAGES_TITLE,
  MESSAGES_NEW,
  MESSAGES_NO_CONVERSATIONS,
  MESSAGES_LOAD_FAILED,
  MESSAGES_UNREAD,
  MESSAGES_CONVERSATION_FALLBACK,
} from "../../content/messages";
import { SETTINGS_RETRY } from "../../content/settings";

export function ConversationList({
  conversations,
  loadFailed = false,
  onRetry,
  activeId,
  onSelect,
  onNewMessage,
}: {
  conversations: Conversation[];
  /** The list could not be read — not the same fact as an empty one (CA-E1). */
  loadFailed?: boolean;
  onRetry?: () => void;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewMessage: () => void;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3">
        <p className="font-mono text-[12px] uppercase tracking-[0.04em] text-black">
          {MESSAGES_TITLE}
        </p>
        <button
          onClick={onNewMessage}
          data-explain="messages.new"
          className="text-ui-xs font-sans text-crimson hover:text-crimson-dark"
        >
          {MESSAGES_NEW}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loadFailed ? (
          <div className="px-4 py-8 text-center">
            <p className="text-ui-xs font-sans text-grey-600">
              {MESSAGES_LOAD_FAILED}{" "}
              <button onClick={onRetry} className="btn-text-muted">
                {SETTINGS_RETRY}
              </button>
            </p>
          </div>
        ) : conversations.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-ui-xs font-sans text-grey-600">
              {MESSAGES_NO_CONVERSATIONS}
            </p>
          </div>
        ) : (
          conversations.map((conv) => {
            const otherMembers = conv.members.filter((m) => m.username);
            const displayName =
              otherMembers.map((m) => m.displayName ?? m.username).join(", ") ||
              MESSAGES_CONVERSATION_FALLBACK;
            const isActive = conv.id === activeId;

            return (
              <button
                key={conv.id}
                onClick={() => onSelect(conv.id)}
                className={`w-full text-left px-4 py-3 transition-colors ${
                  isActive ? "bg-grey-200/60" : "hover:bg-grey-200/40"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {conv.unreadCount > 0 && (
                        <span
                          className="w-2 h-2  bg-crimson flex-shrink-0"
                          aria-hidden="true"
                        />
                      )}
                      {conv.unreadCount > 0 && (
                        <span className="sr-only">{MESSAGES_UNREAD}</span>
                      )}
                      <p
                        className={`text-ui-sm font-sans truncate ${conv.unreadCount > 0 ? "font-semibold text-black" : "text-black"}`}
                      >
                        {displayName}
                      </p>
                    </div>
                  </div>
                  <span className="font-mono text-[12px] text-grey-600 uppercase flex-shrink-0">
                    {timeAgo(conv.lastMessageAt ?? conv.createdAt, { compact: true })}
                  </span>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
