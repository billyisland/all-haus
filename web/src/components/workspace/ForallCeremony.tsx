"use client";

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CEREMONY_TIMINGS,
  REDUCED_MOTION_FADE_MS,
  prefersReducedMotion,
  type CeremonyTiming,
} from "../../lib/workspace/motion";

// ForallCeremony — Slice 9. Renders the ∀ → H → ⊔ transformation as an
// absolutely-positioned overlay on the workspace floor. Two paces:
// `ceremonial` (first-login, ~3000ms, terminal state populated with card
// placeholders) and `responsive` (feed-creation, ~1300ms, terminal empty ⊔).
//
// The ceremony is theatrical, not a visual continuation: the actual vessel
// mounts beneath the ceremony when `onComplete` fires. The ceremonial
// sequence's final settle position differing from the eventual founder's-feed
// grid slot is a deliberate polish-deferral — see ADR §"Slice 9 skipped".

const BOX_W = 300;
const BOX_H = 300;
const WALL = 8;

// Geometry inside the 300x300 viewBox.
//   verticals — full height left + right
//   crossbar (H position)  — y = 146..154, x = 8..292
//   crossbar (⊔ base)      — y = 292..300, x = 0..300
const LEFT_X = 0;
const RIGHT_X = BOX_W - WALL;
const VBAR_Y = 0;
const VBAR_H = BOX_H;
const H_CROSS_Y = (BOX_H - WALL) / 2; // 146
const H_CROSS_X = WALL;
const H_CROSS_W = BOX_W - WALL * 2; // 284
const U_CROSS_Y = BOX_H - WALL; // 292
const U_CROSS_X = 0;
const U_CROSS_W = BOX_W; // 300

// Walls + cards take their colour from the medium-bright palette so the
// ceremony resolves into the colour the eventual vessel renders at. The
// crimson ∀ matches the spec's first-login crimson.
const CRIMSON = "var(--ah-crimson)";
const WALL_COLOUR = "var(--ah-wall-grey)";
const CARD_COLOUR = "var(--ah-cream)";

type Phase =
  | "forall"
  | "partingToH"
  | "hHold"
  | "crossbarDrop"
  | "cards"
  | "done";

interface ForallCeremonyProps {
  pace: "ceremonial" | "responsive";
  /**
   * Floor-relative top-left of the box the ceremony plays in. The ceremony
   * uses a 300×300 box; the parent decides where in the floor it lives
   * (viewport-centred for first-login; destination grid slot for new-feed).
   */
  target: { x: number; y: number };
  onComplete: () => void;
}

export function ForallCeremony({
  pace,
  target,
  onComplete,
}: ForallCeremonyProps) {
  const t = CEREMONY_TIMINGS[pace];
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const [phase, setPhase] = useState<Phase>("forall");

  useEffect(() => {
    if (reduced) {
      const id = setTimeout(onComplete, REDUCED_MOTION_FADE_MS);
      return () => clearTimeout(id);
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
    let acc = t.forallIn + t.forallHold;
    at(acc, () => setPhase("partingToH"));
    acc += t.partToH;
    at(acc, () => setPhase("hHold"));
    acc += t.hHold;
    at(acc, () => setPhase("crossbarDrop"));
    acc += t.crossbarDrop;
    if (pace === "ceremonial") {
      at(acc, () => setPhase("cards"));
      acc += t.cardsSnap;
    }
    at(acc, () => setPhase("done"));
    acc += t.settle;
    at(acc, onComplete);
    return () => timers.forEach(clearTimeout);
  }, [pace, t, reduced, onComplete]);

  // Reduced-motion variant — a single brief fade-in of the static ⊔. The
  // ADR §2 reduced-motion contract is "fade-in fallback rather than the full
  // transformation."
  if (reduced) {
    return (
      <CeremonyFrame target={target}>
        <motion.svg
          viewBox={`0 0 ${BOX_W} ${BOX_H}`}
          width={BOX_W}
          height={BOX_H}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: REDUCED_MOTION_FADE_MS / 1000 }}
        >
          <Verticals />
          <UnionBase />
        </motion.svg>
      </CeremonyFrame>
    );
  }

  const showForall = phase === "forall" || phase === "partingToH";
  const showH =
    phase === "partingToH" || phase === "hHold" || phase === "crossbarDrop";
  const showCards = phase === "cards" || phase === "done";
  const crossbarY =
    phase === "crossbarDrop" || phase === "cards" || phase === "done"
      ? U_CROSS_Y
      : H_CROSS_Y;
  const crossbarX =
    phase === "crossbarDrop" || phase === "cards" || phase === "done"
      ? U_CROSS_X
      : H_CROSS_X;
  const crossbarW =
    phase === "crossbarDrop" || phase === "cards" || phase === "done"
      ? U_CROSS_W
      : H_CROSS_W;

  return (
    <CeremonyFrame target={target}>
      <svg viewBox={`0 0 ${BOX_W} ${BOX_H}`} width={BOX_W} height={BOX_H}>
        {/* ∀ glyph — crimson Literata, scales in then fades as the H bars
            resolve. transformOrigin centres the scale so the glyph blooms
            from the middle of the box. */}
        <AnimatePresence>
          {showForall && (
            <motion.text
              key="forall"
              x={BOX_W / 2}
              y={BOX_H / 2}
              textAnchor="middle"
              dominantBaseline="middle"
              fontFamily="Literata, serif"
              fontSize={140}
              fontWeight={400}
              fill={CRIMSON}
              initial={{ opacity: 0, scale: 0.4 }}
              animate={{
                opacity: phase === "partingToH" ? 0 : 1,
                scale: 1,
              }}
              exit={{ opacity: 0 }}
              transition={{
                duration:
                  phase === "forall" ? t.forallIn / 1000 : t.partToH / 1000,
                ease: [0.25, 0.1, 0.25, 1],
              }}
              style={{ transformOrigin: `${BOX_W / 2}px ${BOX_H / 2}px` }}
            >
              ∀
            </motion.text>
          )}
        </AnimatePresence>

        {/* Verticals — fade in as the ∀ parts. They stay rooted through H
            and ⊔; their geometry is identical in both terminal states. */}
        <AnimatePresence>
          {(showH || showCards) && (
            <motion.g
              key="verticals"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{
                duration: t.partToH / 1000,
                ease: [0.25, 0.1, 0.25, 1],
              }}
            >
              <Verticals />
            </motion.g>
          )}
        </AnimatePresence>

        {/* Crossbar — appears mid-H, then animates Y + X + width to become
            the ⊔ base. Snap-not-morph stays via easing: a quick easeIn on
            the crossbarDrop phase reads as decisive rather than soft. */}
        <AnimatePresence>
          {(showH || showCards) && (
            <motion.rect
              key="crossbar"
              initial={{
                opacity: 0,
                x: H_CROSS_X,
                y: H_CROSS_Y,
                width: H_CROSS_W,
              }}
              animate={{
                opacity: 1,
                x: crossbarX,
                y: crossbarY,
                width: crossbarW,
              }}
              transition={{
                opacity: {
                  duration: t.partToH / 1000,
                  ease: [0.25, 0.1, 0.25, 1],
                },
                x: {
                  duration: t.crossbarDrop / 1000,
                  ease: [0.33, 0, 0.15, 1],
                },
                y: {
                  duration: t.crossbarDrop / 1000,
                  ease: [0.33, 0, 0.15, 1],
                },
                width: {
                  duration: t.crossbarDrop / 1000,
                  ease: [0.33, 0, 0.15, 1],
                },
              }}
              height={WALL}
              fill={WALL_COLOUR}
            />
          )}
        </AnimatePresence>

        {/* Cards — only the ceremonial pace shows them. Snap, not morph: a
            very short fade so they read as "resolving in place" rather than
            sliding. */}
        <AnimatePresence>
          {showCards && pace === "ceremonial" && (
            <motion.g
              key="cards"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{
                duration: t.cardsSnap / 1000,
                ease: [0.25, 0.1, 0.25, 1],
              }}
            >
              <CardPlaceholder y={32} />
              <CardPlaceholder y={120} />
              <CardPlaceholder y={208} />
            </motion.g>
          )}
        </AnimatePresence>
      </svg>
    </CeremonyFrame>
  );
}

function CeremonyFrame({
  target,
  children,
}: {
  target: { x: number; y: number };
  children: React.ReactNode;
}) {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: target.x,
        top: target.y,
        width: BOX_W,
        height: BOX_H,
        pointerEvents: "none",
        zIndex: 40,
      }}
    >
      {children}
    </div>
  );
}

function Verticals() {
  return (
    <g fill={WALL_COLOUR}>
      <rect x={LEFT_X} y={VBAR_Y} width={WALL} height={VBAR_H} />
      <rect x={RIGHT_X} y={VBAR_Y} width={WALL} height={VBAR_H} />
    </g>
  );
}

function UnionBase() {
  return (
    <rect
      x={U_CROSS_X}
      y={U_CROSS_Y}
      width={U_CROSS_W}
      height={WALL}
      fill={WALL_COLOUR}
    />
  );
}

function CardPlaceholder({ y }: { y: number }) {
  // 252 × 70 inset from the verticals + interior padding (8 + 16 = 24).
  return <rect x={24} y={y} width={252} height={70} fill={CARD_COLOUR} />;
}
