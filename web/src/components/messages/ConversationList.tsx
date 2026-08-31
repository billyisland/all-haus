"use client";

import { type Conversation } from "../../lib/api";
import { timeAgo } from "../../lib/format";

export function ConversationList({
  conversations,
  activeId,
  onSelect,
  onNewMessage,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewMessage: () => void;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3">
        <p className="font-mono text-[12px] uppercase tracking-[0.04em] text-black">
          Messages
        </p>
        <button
          onClick={onNewMessage}
          data-explain="messages.new"
          className="text-ui-xs font-sans text-crimson hover:text-crimson-dark"
        >
          New
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-ui-xs font-sans text-grey-600">
              No conversations yet.
            </p>
          </div>
        ) : (
          conversations.map((conv) => {
            const otherMembers = conv.members.filter((m) => m.username);
            const displayName =
              otherMembers.map((m) => m.displayName ?? m.username).join(", ") ||
              "Conversation";
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
                        <span className="sr-only">Unread</span>
                      )}
                      <p
                        className={`text-ui-sm font-sans truncate ${conv.unreadCount > 0 ? "font-semibold text-black" : "text-black"}`}
                      >
                        {displayName}
                      </p>
                    </div>
                    {conv.lastMessage && (
                      <p className="text-ui-xs font-sans text-grey-600 truncate mt-0.5">
                        {conv.lastMessage.content}
                      </p>
                    )}
                  </div>
                  {conv.lastMessage && (
                    <span className="font-mono text-[12px] text-grey-600 uppercase flex-shrink-0">
                      {timeAgo(conv.lastMessage.createdAt, { compact: true })}
                    </span>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
