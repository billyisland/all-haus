import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// =============================================================================
// AES-256-GCM credential encryption
//
// Used to encrypt OAuth access / refresh tokens and Mastodon client secrets
// stored in network_presences.credentials_enc, oauth_app_registrations.
// client_secret_enc, and atproto_oauth_sessions.session_data_enc.
//
// Storage format (base64url, single string):
//   v0 (legacy, no version byte): base64url(iv ‖ authTag ‖ ciphertext)
//   v1+ (versioned):              base64url(0x01 ‖ iv ‖ authTag ‖ ciphertext)
//                                       where the leading byte encodes the key
//                                       version used to encrypt the row.
//
// Multiple keys can be kept active for rollover: writes always use
// LINKED_ACCOUNT_KEY_HEX (the current key); decryption also tries
// LINKED_ACCOUNT_KEY_HEX_V{n} fallbacks keyed by the version byte.
// Legacy (unversioned) blobs are detected by length and fall back to the
// current key, matching the pre-versioning behaviour.
// =============================================================================

const IV_LEN = 12
const TAG_LEN = 16
// Without `authTagLength` Node accepts a 4–16 byte tag on decrypt, so a
// truncated stored blob would verify against a weaker tag than the one
// written; pinned, a short tag throws (CA-F14c).
const GCM_TAG = { authTagLength: TAG_LEN } as const

// Range of version bytes we treat as "plausibly versioned" in decrypt(). 1–8
// is plenty: one key rotation per deploy cycle for a few years, while still
// leaving most of the 0–255 byte space to be safely treated as "this is a v0
// random IV, not a version marker".
const MAX_KNOWN_VERSION = 8

function parseHexKey(hex: string): Buffer {
  if (hex.length !== 64) throw new Error('Key material must be 64 hex chars (32 bytes)')
  return Buffer.from(hex, 'hex')
}

// Current write-side key version. Controlled by LINKED_ACCOUNT_KEY_VERSION so
// an operator can rotate without a code deploy: add LINKED_ACCOUNT_KEY_HEX_V{n}
// for the old key, set LINKED_ACCOUNT_KEY_HEX to the new material, bump the
// version env var, restart. Reads still fall back to any configured _V{n}.
function getCurrentKeyVersion(): number {
  const raw = process.env.LINKED_ACCOUNT_KEY_VERSION
  if (!raw) return 1
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > MAX_KNOWN_VERSION) {
    throw new Error(
      `LINKED_ACCOUNT_KEY_VERSION must be an integer between 1 and ${MAX_KNOWN_VERSION}; got "${raw}"`
    )
  }
  return n
}

function getCurrentKey(): Buffer {
  const hex = process.env.LINKED_ACCOUNT_KEY_HEX
  if (!hex) throw new Error('LINKED_ACCOUNT_KEY_HEX is not set')
  return parseHexKey(hex)
}

// Resolve the key for a given version byte. The version matching the current
// write-side version always uses LINKED_ACCOUNT_KEY_HEX; other versions pull
// from LINKED_ACCOUNT_KEY_HEX_V{n} so an operator can keep previous keys
// active during a rollover window without rewriting every encrypted row.
function getKeyForVersion(version: number): Buffer {
  if (version === getCurrentKeyVersion()) return getCurrentKey()
  const env = process.env[`LINKED_ACCOUNT_KEY_HEX_V${version}`]
  if (!env) throw new Error(`No key material available for version ${version}`)
  return parseHexKey(env)
}

export function encryptCredentials(plaintext: string): string {
  const key = getCurrentKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const versionByte = Buffer.from([getCurrentKeyVersion()])
  return Buffer.concat([versionByte, iv, tag, ct]).toString('base64url')
}

export function decryptCredentials(blob: string): string {
  const buf = Buffer.from(blob, 'base64url')

  // Detect format by length. The legacy (v0) layout is iv ‖ tag ‖ ct, so the
  // minimum blob is IV_LEN + TAG_LEN + 1 = 29 bytes. A versioned blob adds one
  // leading byte, so the minimum is 30. Anything shorter is corrupt.
  if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error('Ciphertext too short')

  // Versioned format: the first byte is a small integer (1..255) that doesn't
  // collide with the first byte of a random 12-byte IV in any ambiguous way —
  // legacy blobs also start with a random byte, so there's no clean way to
  // disambiguate purely by content. We treat anything whose first byte matches
  // a known version *and* whose remainder is long enough as versioned; any
  // blob without a known version is decrypted with the current key (legacy).
  const maybeVersion = buf[0]
  const isVersioned = (maybeVersion >= 1 && maybeVersion <= MAX_KNOWN_VERSION) &&
    buf.length >= 1 + IV_LEN + TAG_LEN + 1

  if (isVersioned) {
    // KEY RESOLUTION IS OUTSIDE THE TRY, AND IT IS TERMINAL.
    //
    // Two unrelated causes used to share one `catch`, and only one of them is
    // a reason to fall through. `getKeyForVersion` throws when the operator has
    // not configured `LINKED_ACCOUNT_KEY_HEX_V{n}` for a version that IS in the
    // data — a CONFIGURATION fact, and one the legacy path cannot possibly
    // recover from (a versioned blob read at v0 offsets has its iv and tag one
    // byte out by construction). Swallowed, the operator was handed the legacy
    // path's `Unsupported state or unable to authenticate data`, which says the
    // credential is corrupt. It is not: it is fine, and the key to read it was
    // never supplied. Rotating a key and then meeting that message is exactly
    // the moment somebody concludes the rollover destroyed the rows.
    //
    // The DECRYPTION throwing is the ambiguous case the fall-through exists for
    // — a v0 blob whose random first byte happened to look like a version — and
    // that one still falls through. Same terminal-vs-ambiguous split as the
    // Stripe and outbound classifiers.
    let key: Buffer
    try {
      key = getKeyForVersion(maybeVersion)
    } catch (err) {
      throw new Error(
        `Cannot decrypt a version-${maybeVersion} credential: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `The stored value is intact; set LINKED_ACCOUNT_KEY_HEX_V${maybeVersion} ` +
          `(or LINKED_ACCOUNT_KEY_HEX, if ${maybeVersion} is the current version) ` +
          `to the key that wrote it.`,
        { cause: err },
      )
    }
    try {
      const iv = buf.subarray(1, 1 + IV_LEN)
      const tag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN)
      const ct = buf.subarray(1 + IV_LEN + TAG_LEN)
      const decipher = createDecipheriv('aes-256-gcm', key, iv, GCM_TAG)
      decipher.setAuthTag(tag)
      const pt = Buffer.concat([decipher.update(ct), decipher.final()])
      return pt.toString('utf8')
    } catch {
      // Fall through to legacy path — the leading byte happened to collide
      // with a valid version number but the row is actually a v0 blob.
    }
  }

  // Legacy (v0): no version byte, full buf is iv ‖ tag ‖ ct, current key.
  const key = getCurrentKey()
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ct = buf.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', key, iv, GCM_TAG)
  decipher.setAuthTag(tag)
  const pt = Buffer.concat([decipher.update(ct), decipher.final()])
  return pt.toString('utf8')
}

// Convenience: encrypt/decrypt a JSON-serialisable credentials object.
// Used for the DecryptedCredentials bag stored on network_presences.
export function encryptJson(value: unknown): string {
  return encryptCredentials(JSON.stringify(value))
}

export function decryptJson<T = unknown>(blob: string): T {
  return JSON.parse(decryptCredentials(blob)) as T
}
