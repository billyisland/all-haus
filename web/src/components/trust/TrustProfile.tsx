"use client";

import { useState, useEffect } from "react";
import { ProfileLink } from "../ui/ProfileLink";
import {
  trust,
  type TrustProfileResponse,
  type VouchDimension,
} from "../../lib/api";
import { Avatar } from "../ui/Avatar";
import { TrustPip } from "../ui/TrustPip";

// =============================================================================
// TrustProfile — dimension bars, public endorsements, Layer 4 relational data
//
// Renders the full trust profile for a user. Fetches from GET /trust/:userId.
// Shows Layer 1 pip + stats, Layer 2 dimension bars (with live vouch counts
// until Phase 4 epoch aggregation ships), public endorsements, and Layer 4
// "your network says" section for authenticated viewers.
// =============================================================================

const DIMENSION_LABELS: Record<
  VouchDimension,
  { name: string; description: string }
> = {
  humanity: { name: "HUMANITY", description: "Is this a real human being?" },
  encounter: {
    name: "ENCOUNTER",
    description: "Have people meaningfully interacted with them?",
  },
  identity: {
    name: "IDENTITY",
    description: "Is their presented identity consistent?",
  },
  integrity: {
    name: "INTEGRITY",
    description: "Do they act honestly and in good faith?",
  },
};

const DIMENSION_ORDER: VouchDimension[] = [
  "humanity",
  "encounter",
  "identity",
  "integrity",
];

function barColor(count: number, score: number): string {
  if (count === 0) return "var(--ah-trust-grey)"; // grey — no attestations
  if (score > 0) {
    // Epoch scores available — use score thresholds
    if (score > 0.7) return "var(--ah-trust-green)"; // green — strong
    if (score > 0.3) return "var(--ah-trust-amber)"; // amber — moderate
    return "var(--ah-trust-grey)"; // grey — thin
  }
  // Pre-epoch fallback: count-based proxy
  if (count >= 5) return "var(--ah-trust-green)";
  if (count >= 2) return "var(--ah-trust-amber)";
  return "var(--ah-trust-grey)";
}

function glossText(count: number): string {
  if (count === 0) return "No attestations yet";
  if (count === 1) return "1 attestor";
  return `${count} attestors`;
}

interface TrustProfileProps {
  userId: string;
  compact?: boolean;
}

export function TrustProfile({ userId, compact = false }: TrustProfileProps) {
  const [data, setData] = useState<TrustProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    trust
      .getProfile(userId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (loading)
    return (
      <div className="text-ui-xs text-grey-600">Loading trust profile…</div>
    );
  if (error || !data) return null;

  return (
    <div className="space-y-6">
      {/* Layer 1 summary */}
      <div className="flex items-center gap-2">
        <TrustPip status={data.layer1.pipStatus} />
        <span className="text-ui-xs text-grey-600">
          {data.layer1.accountAgeDays > 365
            ? `${Math.floor(data.layer1.accountAgeDays / 365)}yr account`
            : `${data.layer1.accountAgeDays}d account`}
          {data.layer1.articleCount > 0 &&
            ` · ${data.layer1.articleCount} article${data.layer1.articleCount !== 1 ? "s" : ""}`}
          {data.layer1.payingReaderCount > 0 &&
            ` · ${data.layer1.payingReaderCount} paying reader${data.layer1.payingReaderCount !== 1 ? "s" : ""}`}
          {data.layer1.paymentVerified && " · verified"}
        </span>
      </div>

      {/* Dimension bars */}
      <div className="space-y-4">
        {DIMENSION_ORDER.map((dim) => {
          const d = data.dimensions[dim];
          const label = DIMENSION_LABELS[dim];
          // Bar fill: use epoch score when available, count-based proxy as fallback
          const fillPct =
            d.score > 0
              ? Math.round(d.score * 100)
              : d.attestationCount > 0
                ? Math.min(d.attestationCount * 20, 100)
                : 0;
          const color = barColor(d.attestationCount, d.score);

          return (
            <div key={dim}>
              <div
                className="label-ui text-grey-600 mb-1.5"
                id={`trust-dim-${dim}`}
              >
                {label.name}
              </div>
              <div
                className="h-[4px] bg-grey-200 w-full"
                role="progressbar"
                aria-valuenow={fillPct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-labelledby={`trust-dim-${dim}`}
              >
                <div
                  className="h-[4px] transition-all duration-300"
                  style={{ width: `${fillPct}%`, backgroundColor: color }}
                />
              </div>
              <div className="text-[11px] font-sans text-grey-600 leading-[1.4] mt-1">
                {glossText(d.attestationCount)}
              </div>
            </div>
          );
        })}
      </div>

      {/* Layer 4 — your network says */}
      {data.layer4 && (
        <div>
          <div className="label-ui text-grey-600 mb-1.5">YOUR NETWORK SAYS</div>
          <p className="text-[11px] font-sans text-grey-600 leading-[1.4] italic">
            {data.layer4.networkSays}
          </p>
          {data.layer4.attributedEndorsements.length > 0 && !compact && (
            <div className="mt-2 space-y-1">
              {data.layer4.attributedEndorsements.slice(0, 5).map((e, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Avatar
                    src={e.attestor.avatar}
                    name={e.attestor.displayName ?? e.attestor.username}
                    size={16}
                  />
                  <ProfileLink
                    href={`/${e.attestor.username}`}
                    className="text-[11px] font-sans text-grey-600 hover:text-black"
                  >
                    {e.attestor.displayName ?? e.attestor.username}
                  </ProfileLink>
                  <span className="label-ui text-grey-600">{e.dimension}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Public endorsements */}
      {!compact && data.publicEndorsements.length > 0 && (
        <div>
          <div className="label-ui text-grey-600 mb-2">
            PUBLIC ENDORSEMENTS ({data.publicEndorsements.length})
          </div>
          <div className="space-y-2">
            {data.publicEndorsements.slice(0, 10).map((e) => (
              <div key={e.id} className="flex items-center gap-2">
                <Avatar
                  src={e.attestor.avatar}
                  name={e.attestor.displayName ?? e.attestor.username}
                  size={20}
                />
                <ProfileLink
                  href={`/${e.attestor.username}`}
                  className="text-ui-xs text-grey-600 hover:text-black"
                >
                  {e.attestor.displayName ?? e.attestor.username}
                </ProfileLink>
                <span className="label-ui text-grey-600">{e.dimension}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
