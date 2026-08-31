"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  linkedAccounts,
  getNetworkCapabilities,
  ASSISTED_BLUESKY_CONSENT,
  assistedMastodonConsent,
  type LinkedAccount,
} from "../../lib/api/linked-accounts";
import { externalItems } from "../../lib/api/external-items";
import { useSettingsOverlay } from "../../stores/settingsOverlay";
import { isDarkPalette, type VesselPalette } from "./tokens";

const PROTOCOL_LABELS: Record<string, string> = {
  atproto: "BLUESKY",
  activitypub: "MASTODON",
  nostr_external: "NOSTR",
};

const MAX_CHARS = 1000;

interface Props {
  itemId: string;
  protocol: string;
  linkedAccount: LinkedAccount | null;
  palette: VesselPalette;
  onClose: () => void;
  onReplied: () => void;
}

export function InlineReplyBox({
  itemId,
  protocol,
  linkedAccount,
  palette,
  onClose,
  onReplied,
}: Props) {
  const [content, setContent] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assistedAvailable, setAssistedAvailable] = useState(false);
  const [assistedInstance, setAssistedInstance] = useState("mastodon.social");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ASSISTED "set one up": Bluesky on Phase 2 (§6.1), Mastodon on Phase 3 (§9).
  // Gate on the server flags so the prompt stays "coming soon" when dark.
  useEffect(() => {
    if (protocol !== "atproto" && protocol !== "activitypub") return;
    let live = true;
    void getNetworkCapabilities().then((c) => {
      if (!live) return;
      if (protocol === "atproto") {
        setAssistedAvailable(c.assistedBluesky);
      } else {
        setAssistedAvailable(c.assistedMastodon);
        const def = c.assistedMastodonInstances?.[0];
        if (def) setAssistedInstance(def);
      }
    });
    return () => {
      live = false;
    };
  }, [protocol]);

  async function handleAssisted() {
    const consent =
      protocol === "atproto"
        ? ASSISTED_BLUESKY_CONSENT
        : assistedMastodonConsent(assistedInstance);
    if (!window.confirm(consent)) return;
    try {
      const { authorizeUrl } =
        protocol === "atproto"
          ? await linkedAccounts.assistedBluesky()
          : await linkedAccounts.assistedMastodon();
      window.location.href = authorizeUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start setup");
    }
  }

  // Inset-panel fill replaces the old thin grey borders (lines are banned
  // sitewide). A dark wash reads on the light card, a light wash on the dark card.
  const panelWash = isDarkPalette(palette)
    ? "rgb(var(--ah-white-rgb) / 0.05)"
    : "rgba(0,0,0,0.04)";

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const autoGrow = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);

  async function handleSubmit() {
    if (!linkedAccount || !content.trim() || publishing) return;
    setPublishing(true);
    setError(null);
    try {
      await externalItems.reply(itemId, linkedAccount.id, content.trim());
      onReplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send reply");
      setPublishing(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  if (!linkedAccount) {
    return (
      <div
        onClick={(e) => e.stopPropagation()}
        className="mt-3 py-3 px-4 rounded"
        style={{ background: panelWash }}
      >
        <p className="text-ui-xs" style={{ color: palette.cardStandfirst }}>
          Connect your {PROTOCOL_LABELS[protocol] ?? protocol} account to reply.{" "}
          <button
            type="button"
            onClick={() => useSettingsOverlay.getState().open()}
            className="underline"
            style={{ color: palette.cardTitle }}
          >
            Settings →
          </button>
        </p>
        <p className="text-ui-xs mt-1" style={{ color: palette.cardMeta }}>
          {assistedAvailable ? (
            <>
              Don&apos;t have one?{" "}
              <button
                type="button"
                onClick={handleAssisted}
                className="underline"
                style={{ color: palette.cardTitle }}
              >
                all.haus can set one up for you →
              </button>
            </>
          ) : (
            <>Don&apos;t have one? all.haus can set one up for you — coming soon.</>
          )}
        </p>
        {error && (
          <p className="text-ui-xs mt-1" style={{ color: "var(--ah-crimson)" }}>
            {error}
          </p>
        )}
      </div>
    );
  }

  const platformLabel = PROTOCOL_LABELS[protocol] ?? protocol.toUpperCase();
  const remaining = MAX_CHARS - content.length;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="mt-3 rounded overflow-hidden"
      style={{ background: panelWash }}
    >
      <div className="px-3 pt-2 flex items-center justify-between">
        <span className="label-ui" style={{ color: palette.cardMeta }}>
          REPLYING VIA {platformLabel}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-[16px] leading-none transition-opacity hover:opacity-70"
          style={{ color: palette.cardMeta }}
          aria-label="Close reply"
        >
          ×
        </button>
      </div>

      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          autoGrow();
        }}
        onKeyDown={handleKeyDown}
        placeholder="Write a reply…"
        maxLength={MAX_CHARS}
        rows={2}
        className="w-full px-3 py-2 text-ui-sm resize-none outline-none bg-transparent"
        style={{ color: palette.cardTitle, caretColor: palette.cardTitle }}
        disabled={publishing}
      />

      <div className="px-3 pb-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {error && (
            <span className="text-ui-xs" style={{ color: "var(--ah-crimson)" }}>
              {error}
            </span>
          )}
          {remaining <= 100 && (
            <span
              className="label-ui"
              style={{ color: remaining <= 0 ? "var(--ah-crimson)" : "var(--ah-grey-400)" }}
            >
              {remaining}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!content.trim() || content.length > MAX_CHARS || publishing}
          className="label-ui px-3 py-1 rounded disabled:opacity-40"
          style={{
            background: "var(--ah-ink)",
            color: "var(--ah-white)",
          }}
        >
          {publishing ? "SENDING…" : "REPLY"}
        </button>
      </div>
    </div>
  );
}
