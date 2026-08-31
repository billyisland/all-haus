"use client";

import { useState } from "react";
import { isDarkPalette, type VesselPalette } from "./tokens";

interface PollOption {
  title: string;
  votesCount: number;
}

interface PollDisplayProps {
  poll: {
    options: PollOption[];
    multiple: boolean;
    expiresAt: string | null;
    closed: boolean;
  };
  canVote: boolean;
  onVote: (choices: number[]) => void;
  voting: boolean;
  palette: VesselPalette;
}

export function PollDisplay({
  poll,
  canVote,
  onVote,
  voting,
  palette,
}: PollDisplayProps) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const totalVotes = poll.options.reduce((s, o) => s + o.votesCount, 0);
  const showResults = poll.closed || !canVote;
  // Options are filled chips (no thin outline — lines are banned sitewide).
  // `trackWash` is the unfilled chip; `resultWash` the stronger fill that reads
  // as the result bar against it. Both are mode-aware: a dark wash on the light
  // card, a light wash on the dark card (a black wash vanishes there).
  const dark = isDarkPalette(palette);
  const trackWash = dark ? "rgb(var(--ah-white-rgb) / 0.05)" : "rgba(0,0,0,0.04)";
  const resultWash = dark ? "rgb(var(--ah-white-rgb) / 0.14)" : "rgba(0,0,0,0.10)";
  const selectedWash = "rgb(var(--ah-crimson-rgb) / 0.14)"; // crimson tint marks selection

  function toggleOption(index: number) {
    if (!canVote || voting) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        if (!poll.multiple) next.clear();
        next.add(index);
      }
      return next;
    });
  }

  return (
    <div className="mt-2 space-y-1.5">
      {poll.options.map((opt, i) => {
        const pct =
          totalVotes > 0 ? Math.round((opt.votesCount / totalVotes) * 100) : 0;
        const isSelected = selected.has(i);

        return (
          <button
            key={i}
            type="button"
            disabled={!canVote || voting || poll.closed}
            onClick={() => toggleOption(i)}
            className="relative w-full text-left rounded px-3 py-1.5 overflow-hidden transition-colors"
            style={{
              background: isSelected ? selectedWash : trackWash,
              cursor:
                canVote && !voting && !poll.closed ? "pointer" : "default",
            }}
          >
            {showResults && (
              <div
                className="absolute inset-0 rounded"
                style={{
                  width: `${pct}%`,
                  backgroundColor: resultWash,
                  transition: "width 0.3s ease",
                }}
              />
            )}
            <div className="relative flex items-center justify-between gap-2">
              <span
                className="text-ui-xs flex items-center gap-2"
                style={{ color: palette.cardTitle }}
              >
                {canVote && !poll.closed && (
                  <span
                    className="inline-block w-3.5 h-3.5 border-2 flex-shrink-0"
                    style={{
                      borderRadius: poll.multiple ? "2px" : "50%",
                      backgroundColor: isSelected ? "var(--ah-crimson)" : "transparent",
                      borderColor: isSelected ? "var(--ah-crimson)" : palette.cardMeta,
                    }}
                  />
                )}
                {opt.title}
              </span>
              {showResults && (
                <span
                  className="label-ui flex-shrink-0"
                  style={{ color: palette.cardMeta }}
                >
                  {pct}%
                </span>
              )}
            </div>
          </button>
        );
      })}

      <div className="flex items-center gap-3 mt-2">
        {canVote && !poll.closed && (
          <button
            type="button"
            className="label-ui"
            style={{
              color:
                selected.size > 0 && !voting ? "var(--ah-crimson)" : palette.cardMeta,
              background: "none",
              border: "none",
              padding: 0,
              cursor: selected.size > 0 && !voting ? "pointer" : "default",
            }}
            disabled={selected.size === 0 || voting}
            onClick={() => onVote(Array.from(selected))}
          >
            {voting ? "VOTING..." : "VOTE"}
          </button>
        )}
        <span className="label-ui" style={{ color: palette.cardMeta }}>
          {totalVotes} {totalVotes === 1 ? "VOTE" : "VOTES"}
        </span>
        {poll.closed && (
          <span className="label-ui" style={{ color: palette.cardMeta }}>
            POLL CLOSED
          </span>
        )}
        {!poll.closed && poll.expiresAt && (
          <span className="label-ui" style={{ color: palette.cardMeta }}>
            ENDS {new Date(poll.expiresAt).toLocaleDateString()}
          </span>
        )}
      </div>
    </div>
  );
}
