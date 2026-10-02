import { createHash } from "node:crypto";

// =============================================================================
// atproto TID — the record key an outbound Bluesky write is addressed to.
//
// WHY A CLIENT-CHOSEN KEY AT ALL. `com.atproto.repo.createRecord` lets the PDS
// mint the rkey, so every attempt writes to a fresh path: a lost response on a
// timeout or a 5xx is indistinguishable from a refusal, the job retries, and
// the member's post goes out twice. A key derived from the outbound_posts row
// makes a retry address the SAME record — which is what turns the delivery from
// at-least-once into exactly-once (audit §2.16). It is the same discipline the
// Stripe paths hold with a row-stable idempotency key.
//
// WHY DERIVED RATHER THAN STORED. Both inputs are columns the row already
// carries and never changes (`id`, `created_at`), so there is no window in
// which delivery could run before the key was persisted — and no migration. A
// stored key would need writing before the first attempt, which is one more
// thing that can be half-done.
//
// WHY A TID AND NOT A BASE32 OF THE UUID. `app.bsky.feed.post` declares its key
// type as `tid`, so the PDS validates the SYNTAX and rejects anything else:
// 13 characters of base32-sortable, encoding a 64-bit integer as 1 zero bit,
// 53 bits of microsecond timestamp, then a 10-bit clock identifier. A bare
// encoding of a uuid is refused. The timestamp half comes from the row's own
// `created_at` (so the key sorts where the post belongs, as a TID is meant to)
// and the clock identifier from a hash of the row id (so two posts in the same
// millisecond still differ).
// =============================================================================

const S32 = "234567abcdefghijklmnopqrstuvwxyz";

/** Syntax the PDS enforces for a `tid` record key (atproto spec). */
export const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

function s32encode(n: bigint): string {
  if (n <= 0n) return S32[0];
  let out = "";
  let i = n;
  while (i > 0n) {
    out = S32[Number(i % 32n)] + out;
    i /= 32n;
  }
  return out;
}

/**
 * The record key for one outbound row — a pure function of the row, so every
 * attempt for that row writes to the same path.
 *
 * `createdAt` is the row's `created_at`; a JS Date carries milliseconds where
 * the column carries microseconds, but the truncation is the SAME on every
 * attempt, which is all determinism needs here (this is a derived name, not a
 * position in a timeline).
 */
export function deriveRecordKey(rowId: string, createdAt: Date): string {
  const micros = BigInt(createdAt.getTime()) * 1000n;
  // 10 bits off a hash of the row id — the TID's clock-identifier slot.
  const clockId =
    parseInt(createHash("sha256").update(rowId).digest("hex").slice(0, 4), 16) &
    0x3ff;
  const tid =
    s32encode(micros).padStart(11, S32[0]) +
    s32encode(BigInt(clockId)).padStart(2, S32[0]);
  if (!TID_RE.test(tid)) {
    // Unreachable for any real row date; a loud throw beats a PDS 400 that the
    // classifier would then mark the row permanently failed on.
    throw new Error(`derived rkey is not a well-formed TID: ${tid}`);
  }
  return tid;
}
