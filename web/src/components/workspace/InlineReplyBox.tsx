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
import { InlineReplyPanel } from "../post/InlineReplyPanel";
import { useConfirm } from "../ui/ConfirmDialog";
import { type VesselPalette } from "./tokens";
import { externalReplyNotSent, networkName } from "../../content/conversation";
import { failureSentence } from "../../lib/api/client";

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
  const { ask, dialog } = useConfirm();

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

  async function handleAssisted(e: React.MouseEvent<HTMLElement>) {
    const consent =
      protocol === "atproto"
        ? ASSISTED_BLUESKY_CONSENT
        : assistedMastodonConsent(assistedInstance);
    // The dialog is rendered INSIDE the panel, not beside it: it portals, but
    // React still bubbles its key events up the component tree, and the panel
    // is what stops Enter/Space reaching the card's own handler.
    const ok = await ask(e.currentTarget, {
      title: protocol === "atproto" ? "Set up a Bluesky account?" : "Set up a Mastodon account?",
      body: <span className="whitespace-pre-line">{consent}</span>,
      confirmLabel: "Continue",
      width: 340,
    });
    if (!ok) return;
    try {
      const { authorizeUrl } =
        protocol === "atproto"
          ? await linkedAccounts.assistedBluesky()
          : await linkedAccounts.assistedMastodon();
      window.location.href = authorizeUrl;
    } catch (err) {
      setError(failureSentence(err, "Couldn’t start setting up the account. Please try again."));
    }
  }

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
      const res = await externalItems.reply(itemId, linkedAccount.id, content.trim());
      onReplied();
      if (res.crossPost === "not_sent") {
        // Published here, never queued for the network — say so rather than
        // closing as if it went. The text is cleared so a second press cannot
        // publish the same reply twice.
        setContent("");
        setError(externalReplyNotSent(networkName(protocol)));
        setPublishing(false);
        return;
      }
      onClose();
    } catch (err) {
      setError(failureSentence(err, "Couldn’t send your reply. It’s still in the box, so please try again."));
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

  const platformLabel = PROTOCOL_LABELS[protocol] ?? protocol.toUpperCase();

  if (!linkedAccount) {
    return (
      <InlineReplyPanel
        palette={palette}
        label={`Replying via ${platformLabel}`}
        onClose={onClose}
      >
        <div className="px-3 pb-3 pt-1">
          <p className="text-ui-xs" style={{ color: palette.cardStandfirst }}>
            To reply here, link your {networkName(protocol) ?? protocol} account.{" "}
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
                Don&rsquo;t have one?{" "}
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
              <>Don&rsquo;t have one? Soon, all.haus will be able to set one up for you.</>
            )}
          </p>
          {error && (
            <p className="text-ui-xs mt-1" style={{ color: "var(--ah-crimson)" }}>
              {error}
            </p>
          )}
          {dialog}
        </div>
      </InlineReplyPanel>
    );
  }

  const remaining = MAX_CHARS - content.length;

  return (
    <InlineReplyPanel
      palette={palette}
      label={`Replying via ${platformLabel}`}
      onClose={onClose}
    >
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
    </InlineReplyPanel>
  );
}
