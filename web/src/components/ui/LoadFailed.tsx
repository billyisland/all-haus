/**
 * An outage is NOT an empty state — the one home for saying so.
 *
 * A fetcher that answers a failed response with an empty collection hands the
 * renderer something indistinguishable from success, and every empty state on
 * the site then makes a confident factual claim on the platform's behalf:
 * "NO ARTICLES PUBLISHED YET" over a publication with a full archive, "Nothing
 * in your library yet" over a library the gateway simply would not answer for.
 * The claim is always the reassuring one and always about somebody else's work
 * — or the reader's own — which is what makes it worse than an error.
 *
 * `notFound()` is not the alternative: a 404 makes the same false claim in a
 * stronger form, that the thing does not exist.
 *
 * It began life beside the publication templates, which is where the bug was
 * first found; it now serves the library, the reading log, the profile logs and
 * the network panel too, so it lives with the other shared UI primitives. The
 * rule is in `web/CLAUDE.md` › *An outage renders as an outage*.
 *
 * COLOUR: the default greys are right on the Glasshouse pane (mode-neutral
 * tokens that invert with the global toggle). A caller rendering inside a
 * themed vessel interior or a profile pane passes `color` from its palette
 * (`palette.cardMeta`) — flat greys do not invert with a per-feed colourway,
 * which is the palette-aware-component rule.
 */

/** The label above the sentence. */
export const LOAD_FAILED_LABEL = 'COULDN’T LOAD'

/** The sentence, naming what failed to load (`'this page'` by default). */
export function loadFailedSentence(what: string): string {
  return `Something went wrong at our end while loading ${what}. Nothing is missing — please try again in a moment.`
}

export function LoadFailed({
  what = 'this page',
  color,
}: {
  what?: string
  /** Palette-derived text colour for a themed surface; omit on the pane. */
  color?: string
}) {
  return (
    <div className="py-16 text-center" style={color ? { color } : undefined}>
      <p className={`label-ui${color ? '' : ' text-grey-600'}`}>{LOAD_FAILED_LABEL}</p>
      <p className={`font-sans text-ui-sm mt-3${color ? '' : ' text-grey-600'}`}>
        {loadFailedSentence(what)}
      </p>
    </div>
  )
}
