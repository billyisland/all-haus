import {
  SETTINGS_SAVE,
  SETTINGS_ON,
  SETTINGS_OFF,
  SETTINGS_GROUP_ACCOUNT,
  SETTINGS_PROFILE_LABEL,
  SETTINGS_EMAIL_LABEL,
  SETTINGS_PAYMENT_LABEL,
  SETTINGS_PAYMENT_LABEL_READER,
  SETTINGS_REACH_LABEL,
  SETTINGS_REACH_DESCRIPTION,
  SETTINGS_GROUP_PREFERENCES,
  SETTINGS_NOTIFICATIONS_LABEL,
  SETTINGS_NOTIFICATIONS_DESCRIPTION,
  SETTINGS_BLOCKED_LABEL,
  SETTINGS_MUTED_LABEL,
  SETTINGS_READING_LABEL,
  SETTINGS_GROUP_DATA,
  SETTINGS_EXPORT_LABEL,
  SETTINGS_EXPORT_DESCRIPTION,
  SETTINGS_GROUP_LEGAL,
  SETTINGS_LEGAL_READ,
  LEGAL_TERMS_LABEL,
  LEGAL_TERMS_DESCRIPTION,
  LEGAL_PRIVACY_LABEL,
  LEGAL_PRIVACY_DESCRIPTION,
  LEGAL_READER_TERMS_LABEL,
  LEGAL_READER_TERMS_DESCRIPTION,
  LEGAL_WRITER_AGREEMENT_LABEL,
  LEGAL_WRITER_AGREEMENT_DESCRIPTION,
  PROFILE_PHOTO_LABEL,
  PROFILE_REMOVE_PHOTO,
  PROFILE_DISPLAY_NAME_LABEL,
  PROFILE_BIO_LABEL,
  PROFILE_BIO_PLACEHOLDER,
  PROFILE_SAVE,
  PROFILE_PUBLIC_KEY_LABEL,
  USERNAME_LABEL,
  USERNAME_PLACEHOLDER,
  USERNAME_INVALID,
  USERNAME_REDIRECT_NOTE,
  usernameCooldownSentence,
  EMAIL_PLACEHOLDER,
  EMAIL_NONE,
  DANGER_HEADING,
  DEACTIVATE_LABEL,
  DEACTIVATE_HELP,
  DEACTIVATE_BUTTON,
  DELETE_LABEL,
  DELETE_HELP,
  DELETE_BUTTON,
  DELETE_CONFIRM_LABEL,
  DELETE_CONSEQUENCES_INTRO,
  DELETE_CONSEQUENCES,
  DELETE_EARNINGS_BEFORE,
  DELETE_EARNINGS_EMPHASIS,
  DELETE_EARNINGS_AFTER,
  DELETE_EMAIL_CONFIRM_LABEL,
  EXPORT_INTRO,
  EXPORT_RECEIPTS_TITLE,
  EXPORT_RECEIPTS_DESCRIPTION,
  EXPORT_ACCOUNT_TITLE,
  EXPORT_ACCOUNT_DESCRIPTION,
  BLOCKS_EMPTY,
  BLOCKS_UNBLOCK,
  BLOCKS_LOAD_FAILED,
  MUTES_EMPTY,
  MUTES_UNMUTE,
  MUTES_LOAD_FAILED,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_LABEL,
  NOTIFICATION_PLEDGES_ONLY,
} from '../../content/settings'
import { WRITER_ACCESS_TITLE, WRITER_APPLY } from '../../content/writer-access'
import {
  NOSTR_TITLE,
  NOSTR_PUBLIC,
  NOSTR_PRIVATE,
  NOSTR_PUBLIC_LABEL,
  NOSTR_PRIVATE_LABEL,
  NOSTR_FOLLOW_GRAPH,
  TOGGLE_ON,
  TOGGLE_OFF,
  EMAIL_FINDABLE_TITLE,
  EMAIL_FINDABLE_ON,
  EMAIL_FINDABLE_OFF,
  PREFS_LOAD_FAILED,
  NETWORK_LABEL_BLUESKY,
  NETWORK_LABEL_MASTODON,
  NETWORK_INVALID,
  NETWORK_RECONNECT_NOTE,
  NETWORK_RECONNECT,
  networkCrossPostOffer,
  NETWORK_DEFAULT_ON,
  NETWORK_SHOW_ON_PROFILE,
  NETWORK_DISCONNECT,
  NETWORK_LINK_YOURS,
  MASTODON_INSTANCE_LABEL,
  MASTODON_INSTANCE_PLACEHOLDER,
  BLUESKY_HANDLE_LABEL,
  BLUESKY_HANDLE_PLACEHOLDER,
  FOLLOW_IMPORT_TITLE,
  followImportIntro,
  FOLLOW_IMPORT_PLACEHOLDER,
  FOLLOW_IMPORT_PLACEHOLDER_WITH_MASTODON,
  FOLLOW_IMPORT_NO_MATCH,
  FOLLOW_IMPORT_UNIMPORTABLE,
  FOLLOW_IMPORT_ACTION,
  OPML_INTRO,
  OPML_UPLOAD,
  OPML_IMPORT,
  OPML_DONE,
  OPML_RUNNING,
  opmlTruncated,
  opmlFolded,
  opmlInvalid,
  OPML_FAILED_ENTRIES,
  opmlRunLead,
  opmlRunFailed,
  opmlRunDone,
  IMPORT_READING,
  importFailed,
  importDone,
  importProgress,
} from '../../content/networks'
import { pledgesEnabled } from '../../lib/featureFlags'
import { safeHttpUrl } from '../../lib/external-links'
import type { MatchOption } from '../../lib/workspace/resolve'
import { query } from '../gateway'
import { PostForm, Hidden, Unavailable } from '../html'
import type { AccountFacts, FollowImportRun, Networks, PrivacyData } from '../settings-loaders'

// =============================================================================
// modernhaus — Settings (MODERNHAUS-ADR §D2.3, E6). The full site's panel is
// one long pane; here each of its groups is a page of its own, reached from
// the index, and every word is the panel's own (`content/settings.ts`,
// `content/networks.ts`).
//
// A SETTING THAT FAILED TO LOAD ASSERTS NOTHING (web-foundations.md): its
// section says so and offers no form, because a form drawn on a guess would
// save the guess.
// =============================================================================

const S = '/modernhaus/settings'

export function SettingsIndexPage(props: {
  facts: AccountFacts
  csrf: string
  values?: { displayName: string; bio: string }
  error?: string | null
}) {
  const { facts } = props
  const v = props.values ?? { displayName: facts.displayName ?? '', bio: facts.bio ?? '' }
  const avatar = safeHttpUrl(facts.avatar)
  return (
    <>
      <h2>{SETTINGS_PROFILE_LABEL}</h2>
      {props.error && <p role="alert">{props.error}</p>}
      <PostForm action="profile_save" csrf={props.csrf} multipart>
        <Hidden values={{ return: S }} />
        <fieldset>
          <legend>{PROFILE_PHOTO_LABEL}</legend>
          {avatar && (
            <p>
              <img src={avatar} alt="" width={64} height={64} loading="lazy" />
              <br />
              <label>
                <input type="checkbox" name="removeAvatar" value="1" /> {PROFILE_REMOVE_PHOTO}
              </label>
            </p>
          )}
          <p>
            <input type="file" name="avatar" accept="image/*" aria-label={PROFILE_PHOTO_LABEL} />
          </p>
        </fieldset>
        <p>
          <label>
            {`${PROFILE_DISPLAY_NAME_LABEL} `}
            <input type="text" name="displayName" defaultValue={v.displayName} maxLength={100} required />
          </label>
        </p>
        <p>
          <label>
            {PROFILE_BIO_LABEL}
            <br />
            <textarea name="bio" rows={4} cols={60} maxLength={500} placeholder={PROFILE_BIO_PLACEHOLDER} defaultValue={v.bio} />
          </label>
        </p>
        <p>
          <button>{PROFILE_SAVE}</button>
        </p>
      </PostForm>
      {facts.pubkey && <p>{`${PROFILE_PUBLIC_KEY_LABEL}: ${facts.pubkey}`}</p>}

      <h2>{SETTINGS_GROUP_ACCOUNT}</h2>
      <ul>
        <li>
          <a href={`${S}/account`}>{`${USERNAME_LABEL}, ${SETTINGS_EMAIL_LABEL.toLowerCase()}, ${DANGER_HEADING.toLowerCase()}`}</a>
        </li>
        <li>
          <a href={`${S}/money`}>{facts.canWrite ? SETTINGS_PAYMENT_LABEL : SETTINGS_PAYMENT_LABEL_READER}</a>
        </li>
        {/* A reader's way to ask to write (READER-WRITER-SPLIT-ADR §6.3). */}
        {!facts.canWrite && (
          <li>
            <a href="/modernhaus/write">{WRITER_ACCESS_TITLE}</a> — {WRITER_APPLY}
          </li>
        )}
        <li>
          <a href={`${S}/networks`}>{SETTINGS_REACH_LABEL}</a> — {SETTINGS_REACH_DESCRIPTION}
        </li>
      </ul>
      <h2>{SETTINGS_GROUP_PREFERENCES}</h2>
      <ul>
        <li>
          <a href={`${S}/notifications`}>{SETTINGS_NOTIFICATIONS_LABEL}</a> — {SETTINGS_NOTIFICATIONS_DESCRIPTION}
        </li>
        <li>
          <a href={`${S}/privacy`}>{`${NOSTR_TITLE}, ${SETTINGS_BLOCKED_LABEL.toLowerCase()}, ${SETTINGS_MUTED_LABEL.toLowerCase()}`}</a>
        </li>
        <li>
          <a href="/modernhaus/history">{SETTINGS_READING_LABEL}</a>
        </li>
      </ul>
      <h2>{SETTINGS_GROUP_DATA}</h2>
      <ul>
        <li>
          <a href={`${S}/account#export`}>{SETTINGS_EXPORT_LABEL}</a> — {SETTINGS_EXPORT_DESCRIPTION}
        </li>
      </ul>
      <h2>{SETTINGS_GROUP_LEGAL}</h2>
      <ul>
        {(
          [
            ['/modernhaus/terms', LEGAL_TERMS_LABEL, LEGAL_TERMS_DESCRIPTION],
            ['/modernhaus/privacy', LEGAL_PRIVACY_LABEL, LEGAL_PRIVACY_DESCRIPTION],
            ['/modernhaus/reader-terms', LEGAL_READER_TERMS_LABEL, LEGAL_READER_TERMS_DESCRIPTION],
            ['/modernhaus/writer-agreement', LEGAL_WRITER_AGREEMENT_LABEL, LEGAL_WRITER_AGREEMENT_DESCRIPTION],
          ] as const
        ).map(([href, label, description]) => (
          <li key={href}>
            {`${label} — ${description} `}
            <a href={href}>{SETTINGS_LEGAL_READ}</a>
          </li>
        ))}
      </ul>
    </>
  )
}

// ---------------------------------------------------------------------------
// Account: username, email, export, and closing the account.
// ---------------------------------------------------------------------------

/** The username cooldown's end (the route's 30 days), or null when a change is open. */
export function usernameCooldownUntil(changedAt: string | null, now: Date): Date | null {
  if (!changedAt) return null
  const at = new Date(changedAt)
  if (Number.isNaN(at.getTime())) return null
  const until = new Date(at.getTime() + 30 * 24 * 60 * 60 * 1000)
  return until > now ? until : null
}

const COOLDOWN_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' })

export function AccountSettingsPage(props: {
  facts: AccountFacts
  csrf: string
  now: Date
  username?: { value: string; error: string }
  email?: { value: string; error: string }
}) {
  const { facts } = props
  const until = usernameCooldownUntil(facts.usernameChangedAt, props.now)
  return (
    <>
      <h2>{USERNAME_LABEL}</h2>
      <p>{facts.username ? `@${facts.username}` : ''}</p>
      {until ? (
        <p>{usernameCooldownSentence(COOLDOWN_DATE.format(until))}</p>
      ) : (
        <PostForm action="username_change" csrf={props.csrf}>
          <Hidden values={{ return: `${S}/account` }} />
          {props.username && <p role="alert">{props.username.error}</p>}
          <p>
            <label>
              {`${USERNAME_LABEL} `}
              <input
                type="text"
                name="newUsername"
                placeholder={USERNAME_PLACEHOLDER}
                defaultValue={props.username?.value ?? ''}
                minLength={3}
                maxLength={30}
                required
              />
            </label>{' '}
            <button>{SETTINGS_SAVE}</button>
          </p>
          <p>{USERNAME_INVALID}</p>
          <p>{USERNAME_REDIRECT_NOTE}</p>
        </PostForm>
      )}

      <h2>{SETTINGS_EMAIL_LABEL}</h2>
      <p>{facts.email ?? EMAIL_NONE}</p>
      <PostForm action="email_change" csrf={props.csrf}>
        <Hidden values={{ return: `${S}/account` }} />
        {props.email && <p role="alert">{props.email.error}</p>}
        <p>
          <label>
            {`${SETTINGS_EMAIL_LABEL} `}
            <input type="email" name="newEmail" placeholder={EMAIL_PLACEHOLDER} defaultValue={props.email?.value ?? ''} required />
          </label>{' '}
          <button>{SETTINGS_SAVE}</button>
        </p>
      </PostForm>

      <h2 id="export">{SETTINGS_EXPORT_LABEL}</h2>
      <p>{EXPORT_INTRO}</p>
      <p>
        {`${EXPORT_RECEIPTS_TITLE} — ${EXPORT_RECEIPTS_DESCRIPTION} `}
        <a href="/modernhaus/receipts/export">Download</a>
      </p>
      <PostForm action="export_request" csrf={props.csrf}>
        <Hidden values={{ return: `${S}/account` }} />
        <p>
          {`${EXPORT_ACCOUNT_TITLE} — ${EXPORT_ACCOUNT_DESCRIPTION} `}
          <button>Email me the link</button>
        </p>
      </PostForm>

      <h2>{DANGER_HEADING}</h2>
      <h3>{DEACTIVATE_LABEL}</h3>
      <p>{DEACTIVATE_HELP}</p>
      <p>
        <a href={`/modernhaus/confirm/deactivate${query({ confirm: '1', return: `${S}/account` })}`}>{DEACTIVATE_BUTTON}</a>
      </p>
      <h3>{DELETE_LABEL}</h3>
      <p>{DELETE_HELP}</p>
      <p>
        <a href={`${S}/account/delete`}>{DELETE_BUTTON}</a>
      </p>
    </>
  )
}

/** The delete confirmation is its own page: it needs the member's email typed. */
export function DeleteAccountPage(props: { csrf: string; email?: string; error?: string | null }) {
  return (
    <>
      <p>{DELETE_CONSEQUENCES_INTRO}</p>
      <ul>
        {DELETE_CONSEQUENCES.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <p>
        {DELETE_EARNINGS_BEFORE}
        <strong>{DELETE_EARNINGS_EMPHASIS}</strong>
        {DELETE_EARNINGS_AFTER}
      </p>
      {props.error && <p role="alert">{props.error}</p>}
      <PostForm action="account_delete" csrf={props.csrf}>
        <p>
          <label>
            {`${DELETE_EMAIL_CONFIRM_LABEL} `}
            <input type="email" name="emailConfirmation" defaultValue={props.email ?? ''} required autoComplete="off" />
          </label>
        </p>
        <p>
          <button>{DELETE_CONFIRM_LABEL}</button>
        </p>
      </PostForm>
      <p>
        <a href={`${S}/account`}>Cancel</a>
      </p>
    </>
  )
}

// ---------------------------------------------------------------------------
// Reach other networks.
// ---------------------------------------------------------------------------

const NETWORKS = [
  { protocol: 'atproto', label: NETWORK_LABEL_BLUESKY },
  { protocol: 'activitypub', label: NETWORK_LABEL_MASTODON },
] as const

export function NetworksPage(props: { networks: Networks; csrf: string }) {
  const { accounts, capabilities } = props.networks
  const importable = capabilities.followImportProtocols ?? []
  return (
    <>
      <p>{SETTINGS_REACH_DESCRIPTION}</p>
      {NETWORKS.map(({ protocol, label }) => {
        const linked = accounts.filter((a) => a.protocol === protocol)
        return (
          <section key={protocol}>
            <h2>{label}</h2>
            {linked.length === 0 && <p>{networkCrossPostOffer(label)}</p>}
            {linked.map((a) => (
              <article key={a.id}>
                <p>
                  {a.externalHandle ?? a.externalId}
                  {!a.isValid && ` — ${NETWORK_INVALID}`}
                </p>
                {a.needsReconnect && (
                  <p>
                    {`${NETWORK_RECONNECT_NOTE} `}
                    {protocol === 'activitypub' && a.instanceUrl ? (
                      <ReconnectButton csrf={props.csrf} protocol={protocol} value={a.instanceUrl} />
                    ) : protocol === 'atproto' && a.externalHandle ? (
                      <ReconnectButton csrf={props.csrf} protocol={protocol} value={a.externalHandle} />
                    ) : null}
                  </p>
                )}
                {/* TWO consents, never one (security.md): posting through the
                    account, and showing it on the profile. Two checkboxes. */}
                <PostForm action="network_update" csrf={props.csrf}>
                  <Hidden values={{ return: `${S}/networks`, id: a.id }} />
                  <p>
                    <label>
                      <input type="checkbox" name="crossPostDefault" value="1" defaultChecked={a.crossPostDefault} />{' '}
                      {NETWORK_DEFAULT_ON}
                    </label>
                  </p>
                  <p>
                    <label>
                      <input type="checkbox" name="showOnProfile" value="1" defaultChecked={a.showOnProfile === true} />{' '}
                      {NETWORK_SHOW_ON_PROFILE}
                    </label>
                  </p>
                  <p>
                    <button>{SETTINGS_SAVE}</button>{' '}
                    <a href={`/modernhaus/confirm/network_unlink${query({ id: a.id, return: `${S}/networks` })}`}>
                      {NETWORK_DISCONNECT}
                    </a>
                  </p>
                </PostForm>
              </article>
            ))}
            {linked.length === 0 && (
              <PostForm action="network_link" csrf={props.csrf}>
                <Hidden values={{ return: `${S}/networks`, protocol }} />
                <p>
                  <label>
                    {`${protocol === 'activitypub' ? MASTODON_INSTANCE_LABEL : BLUESKY_HANDLE_LABEL} `}
                    <input
                      type="text"
                      name="identity"
                      required
                      placeholder={protocol === 'activitypub' ? MASTODON_INSTANCE_PLACEHOLDER : BLUESKY_HANDLE_PLACEHOLDER}
                    />
                  </label>{' '}
                  <button>{NETWORK_LINK_YOURS}</button>
                </p>
                <p>You will be sent to {label} to allow it, and brought back to the full site.</p>
              </PostForm>
            )}
          </section>
        )
      })}
      {(importable.length > 0 || capabilities.followImportOpml) && (
        <section>
          <h2>{FOLLOW_IMPORT_TITLE}</h2>
          {importable.length > 0 && (
            <>
              <p>{followImportIntro(importable.includes('activitypub'))}</p>
              <p>
                <a href={`${S}/networks/import`}>{FOLLOW_IMPORT_ACTION}</a>
              </p>
            </>
          )}
          {capabilities.followImportOpml && (
            <PostForm action="follow_import_opml" csrf={props.csrf} multipart>
              <p>{OPML_INTRO}</p>
              <p>
                <label>
                  {`${OPML_UPLOAD} `}
                  <input type="file" name="opml" accept=".opml,.xml,text/xml,text/x-opml" required />
                </label>{' '}
                <button>{OPML_IMPORT}</button>
              </p>
            </PostForm>
          )}
        </section>
      )}
    </>
  )
}

function ReconnectButton(props: { csrf: string; protocol: string; value: string }) {
  return (
    <PostForm action="network_link" csrf={props.csrf}>
      <Hidden values={{ return: `${S}/networks`, protocol: props.protocol, identity: props.value }} />
      <button>{NETWORK_RECONNECT}</button>
    </PostForm>
  )
}

// ---------------------------------------------------------------------------
// Follow import: the lookup, and a run's progress.
// ---------------------------------------------------------------------------

export function FollowImportLookupPage(props: {
  csrf: string
  q: string
  importable: string[]
  /** Null before a lookup; the candidates the resolver named, split into importable and not. */
  found: { candidates: MatchOption[]; unimportable: boolean } | 'none' | null
}) {
  const { found } = props
  return (
    <>
      <p>{followImportIntro(props.importable.includes('activitypub'))}</p>
      <form method="get" action={`${S}/networks/import`}>
        <p>
          <input
            type="text"
            name="q"
            defaultValue={props.q}
            required
            aria-label={FOLLOW_IMPORT_TITLE}
            placeholder={props.importable.includes('activitypub') ? FOLLOW_IMPORT_PLACEHOLDER_WITH_MASTODON : FOLLOW_IMPORT_PLACEHOLDER}
          />{' '}
          <button>Find</button>
        </p>
      </form>
      {found === 'none' && <p>{FOLLOW_IMPORT_NO_MATCH}</p>}
      {found && found !== 'none' && found.unimportable && <p>{FOLLOW_IMPORT_UNIMPORTABLE}</p>}
      {found && found !== 'none' && found.candidates.length > 0 && (
        <PostForm action="follow_import" csrf={props.csrf}>
          <ul>
            {found.candidates.map((o) =>
              o.add.sourceType === 'external_source' && 'sourceUri' in o.add ? (
                <li key={o.key}>
                  {`${o.label}${o.sublabel ? ` (${o.sublabel})` : ''} `}
                  <button name="origin" value={`${o.add.protocol} ${o.add.sourceUri}`}>
                    {FOLLOW_IMPORT_ACTION}
                  </button>
                </li>
              ) : null,
            )}
          </ul>
        </PostForm>
      )}
    </>
  )
}

/** One run's status line, in the full site's words (FollowImportStatus). */
export function runLine(run: FollowImportRun): string {
  if (run.status === 'failed') return importFailed(run.error)
  if (run.status === 'done') return importDone(run.imported, run.skipped, run.failed)
  if (run.status === 'pending' && run.total === 0) return IMPORT_READING
  return importProgress(run.imported + run.skipped + run.failed, run.total)
}

export function FollowImportStatusPage(props: {
  runs: FollowImportRun[]
  self: string
  /** OPML's plan-level facts, known only on the upload's own response. */
  plan?: { totalEntries: number; remoteTotal: number; truncated: boolean; foldedFolders: number; invalidEntries: number }
  names?: Record<string, string>
}) {
  const running = props.runs.some((r) => r.status === 'pending' || r.status === 'running')
  const anyFailed = props.runs.some((r) => r.failed > 0)
  const plan = props.plan
  return (
    <>
      {props.runs.length === 0 ? (
        <p>You haven’t imported anything yet.</p>
      ) : (
        <ul>
          {props.runs.map((r) => (
            <li key={r.id}>
              {props.names?.[r.id] && opmlRunLead(props.names[r.id])}
              {r.status === 'failed' && props.names?.[r.id]
                ? opmlRunFailed(r.error)
                : r.status === 'done' && props.names?.[r.id]
                  ? opmlRunDone(r.imported, r.skipped, r.failed)
                  : runLine(r)}{' '}
              <a href={`/modernhaus/feed/${encodeURIComponent(r.feedId)}`}>Open the channel</a>
            </li>
          ))}
        </ul>
      )}
      {props.runs.length > 0 && (
        <p>
          {running ? OPML_RUNNING : OPML_DONE}
          {plan?.truncated && opmlTruncated(plan.totalEntries, plan.remoteTotal)}
          {plan && plan.foldedFolders > 0 && opmlFolded(plan.foldedFolders)}
          {plan && plan.invalidEntries > 0 && opmlInvalid(plan.invalidEntries)}
          {anyFailed && OPML_FAILED_ENTRIES}
        </p>
      )}
      {running && (
        <p>
          <a href={props.self}>Check progress</a>
        </p>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Privacy: discovery, findable by email, blocks, mutes.
// ---------------------------------------------------------------------------

function OnOff(props: { name: string; on: boolean; onLabel: string; offLabel: string }) {
  return (
    <>
      <label>
        <input type="radio" name={props.name} value="on" defaultChecked={props.on} /> {props.onLabel}
      </label>{' '}
      <label>
        <input type="radio" name={props.name} value="off" defaultChecked={!props.on} /> {props.offLabel}
      </label>
    </>
  )
}

export function PrivacyPage(props: { data: PrivacyData; csrf: string }) {
  const { prefs, blocks, mutes } = props.data
  const back = `${S}/privacy`
  return (
    <>
      {prefs === null ? (
        <p>{PREFS_LOAD_FAILED}</p>
      ) : (
        <PostForm action="privacy_save" csrf={props.csrf}>
          <Hidden values={{ return: back }} />
          <fieldset>
            <legend>{NOSTR_TITLE}</legend>
            <p>{prefs.discoveryEnabled ? NOSTR_PUBLIC : NOSTR_PRIVATE}</p>
            <p>
              <OnOff name="discoveryEnabled" on={prefs.discoveryEnabled} onLabel={NOSTR_PUBLIC_LABEL} offLabel={NOSTR_PRIVATE_LABEL} />
            </p>
            <p>{NOSTR_FOLLOW_GRAPH}</p>
            <p>
              <OnOff name="publishFollowGraph" on={prefs.publishFollowGraph} onLabel={TOGGLE_ON} offLabel={TOGGLE_OFF} />
            </p>
          </fieldset>
          <fieldset>
            <legend>{EMAIL_FINDABLE_TITLE}</legend>
            <p>{prefs.discoverableByEmail ? EMAIL_FINDABLE_ON : EMAIL_FINDABLE_OFF}</p>
            <p>
              <OnOff name="discoverableByEmail" on={prefs.discoverableByEmail} onLabel={TOGGLE_ON} offLabel={TOGGLE_OFF} />
            </p>
          </fieldset>
          <p>
            <button>{SETTINGS_SAVE}</button>
          </p>
        </PostForm>
      )}

      <h2>{SETTINGS_BLOCKED_LABEL}</h2>
      <PeopleList
        people={blocks}
        empty={BLOCKS_EMPTY}
        failed={BLOCKS_LOAD_FAILED}
        action="unblock"
        label={BLOCKS_UNBLOCK}
        csrf={props.csrf}
        back={back}
      />
      <h2>{SETTINGS_MUTED_LABEL}</h2>
      <PeopleList
        people={mutes}
        empty={MUTES_EMPTY}
        failed={MUTES_LOAD_FAILED}
        action="unmute"
        label={MUTES_UNMUTE}
        csrf={props.csrf}
        back={back}
      />
    </>
  )
}

function PeopleList(props: {
  people: Array<{ userId: string; username: string; displayName: string | null }> | null
  empty: string
  failed: string
  action: string
  label: string
  csrf: string
  back: string
}) {
  if (props.people === null) return <p>{props.failed}</p>
  if (props.people.length === 0) return <p>{props.empty}</p>
  return (
    <PostForm action={props.action} csrf={props.csrf}>
      <Hidden values={{ return: props.back }} />
      <ul>
        {props.people.map((p) => (
          <li key={p.userId}>
            <a href={`/modernhaus/u/${encodeURIComponent(p.username)}`}>{p.displayName?.trim() || p.username}</a>
            {` @${p.username} `}
            <button name="userId" value={p.userId}>
              {props.label}
            </button>
          </li>
        ))}
      </ul>
    </PostForm>
  )
}

// ---------------------------------------------------------------------------
// Notification preferences.
// ---------------------------------------------------------------------------

export function notificationCategoriesShown(): readonly string[] {
  return NOTIFICATION_CATEGORIES.filter((c) => c !== NOTIFICATION_PLEDGES_ONLY || pledgesEnabled())
}

export function NotificationPrefsPage(props: { prefs: Record<string, boolean> | null; csrf: string }) {
  if (props.prefs === null) return <Unavailable what="Your notification settings" />
  const prefs = props.prefs
  return (
    <PostForm action="notification_prefs_save" csrf={props.csrf}>
      <Hidden values={{ return: `${S}/notifications` }} />
      <p>{SETTINGS_NOTIFICATIONS_DESCRIPTION}</p>
      {notificationCategoriesShown().map((c) => (
        <fieldset key={c}>
          <legend>{NOTIFICATION_CATEGORY_LABEL[c as keyof typeof NOTIFICATION_CATEGORY_LABEL]}</legend>
          <OnOff name={c} on={prefs[c] !== false} onLabel={SETTINGS_ON} offLabel={SETTINGS_OFF} />
        </fieldset>
      ))}
      <p>
        <button>{SETTINGS_SAVE}</button>
      </p>
    </PostForm>
  )
}
