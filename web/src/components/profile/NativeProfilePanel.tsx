"use client";

// =============================================================================
// NativeProfilePanel — the OVERLAY register of the native writer profile.
//
// It is a fetcher and nothing else: the /[username] route is a server component
// that fetches the writer at request time, the overlay can't use that, so this
// fetches the same WriterProfile client-side and hands it to the one shared
// body (NativeProfileBody). The header, tiers and rhythm live there — a second
// copy here is exactly the drift PROFILE-PANE-REDESIGN-ADR §5.1 exists to end.
//
// The overlay's difference is the ✕: it passes `onClose`, and tier 1 renders
// the close (D10). The standalone page has nothing to close and passes none.
// =============================================================================

import { useEffect, useState, type ReactNode } from "react";
import { NativeProfileBody } from "./NativeProfileBody";
import { profileIslandStyle, profilePalette } from "./ProfileChrome";
import { useResolvedDark } from "../../stores/colorScheme";
import type { FeedScheme } from "../workspace/tokens";
import { getWriter, type WriterProfile } from "../../lib/api/writers";
import { ApiError } from "../../lib/api/client";

export function NativeProfilePanel({
  username,
  onClose,
  scheme,
}: {
  username: string;
  onClose?: () => void;
  /** The launching feed's colourway — the pane wears it entire. */
  scheme?: FeedScheme | null;
}) {
  const dark = useResolvedDark();
  const palette = profilePalette(scheme, dark);
  const [writer, setWriter] = useState<WriterProfile | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setWriter(null);
    setNotFound(false);
    setError(false);
    getWriter(username)
      .then((w) => {
        if (!cancelled) setWriter(w);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        else setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [username]);

  // The pre-identity states sit on the surface's OWN ground (and carry the same
  // island, when there is one), so a pane that now reaches the window bottom
  // isn't a pale slab while the writer loads.
  const ground = (children: ReactNode) => (
    <div
      data-explain="profile"
      style={{
        ...profileIslandStyle(scheme),
        background: palette.interior,
        minHeight: "100%",
      }}
    >
      {children}
    </div>
  );

  if (notFound) {
    return ground(
      <p
        className="font-sans text-ui-sm py-16 text-center"
        style={{ color: palette.cardStandfirst }}
      >
        @{username} isn&apos;t here.
      </p>,
    );
  }

  if (error) {
    return ground(
      <p
        className="font-sans text-ui-sm py-16 text-center"
        style={{ color: palette.cardStandfirst }}
      >
        Couldn&apos;t load this profile.
      </p>,
    );
  }

  if (!writer) {
    return ground(
      <div className="py-12 px-6 space-y-4 animate-pulse">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-grey-100" />
          <div className="flex-1 space-y-2">
            <div className="h-7 bg-grey-100 rounded w-1/2" />
            <div className="h-4 bg-grey-100 rounded w-1/4" />
          </div>
        </div>
        <div className="h-4 bg-grey-100 rounded w-3/4" />
      </div>,
    );
  }

  return (
    <NativeProfileBody
      username={username}
      writer={writer}
      onClose={onClose}
      scheme={scheme}
      minHeight="100%"
    />
  );
}
