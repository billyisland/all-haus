import { requireEnv } from "../env.js";

// =============================================================================
// How emails spell money, dates and our own URLs. One spelling each.
// =============================================================================

export function formatPounds(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

/** `25 December 2025`, in the process's time zone. */
export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** `25 December 2025`, read in UTC — for a deadline, which must not move with
 *  the server's zone. */
export function formatDateUtc(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** `2026-09-27 14:05 UTC` — a moment a member may need to match against their
 *  own memory of what they did. */
export function formatMomentUtc(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/** `27 Jul, 08:55 UTC` — absolute, for the operator's digest. */
export function formatStampUtc(date: Date): string {
  return (
    date.toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    }) + " UTC"
  );
}

/** A path on the site, as an absolute URL. */
export function siteUrl(path: string): string {
  return `${requireEnv("APP_URL")}${path}`;
}
