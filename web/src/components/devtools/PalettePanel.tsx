"use client";

// =============================================================================
// PalettePanel — TEMPORARY live colour-tuning kit.
//
// Deliberately NOT a Glasshouse: no scrim, no blur, no scroll-lock, no
// participation in the one-glasshouse-at-a-time registry. It floats above
// everything (z-200), the page behind stays sharp and fully interactive, and
// any open overlay keeps its state. Remove this file, its store, and the
// ForallMenu "Palette" row once the colour scheme is finalised.
//
// Hex/gradient literals in this file are picker chrome (the spectrum itself),
// not site colours — they must NOT route through the registry vars, or the
// picker would repaint itself while you tune.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PALETTE_REGISTRY,
  normalizeHex,
  type PaletteEntry,
} from "../../lib/palette/registry";
import { usePaletteDevtool } from "../../stores/paletteDevtool";

// ── colour maths ─────────────────────────────────────────────────────────────

interface Hsv {
  h: number; // 0-360
  s: number; // 0-1
  v: number; // 0-1
}

function hexToHsv(hex: string): Hsv {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToHex({ h, s, v }: Hsv): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to2 = (u: number) =>
    Math.round((u + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to2(r)}${to2(g)}${to2(b)}`.toUpperCase();
}

/** Perceived luminance 0-1 — picks legible index text on a swatch. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (
    (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) /
    255
  );
}

const HUE_GRADIENT =
  "linear-gradient(to right, #f00, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00)";

// ── 2D spectrum picker ───────────────────────────────────────────────────────

function SpectrumPicker({
  hex,
  onChange,
}: {
  hex: string;
  onChange: (hex: string) => void;
}) {
  // HSV held locally so hue survives passing through s=0 / v=0 (where the hex
  // round-trip loses it); re-seeded when an outside change lands a new hex.
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(hex));
  const lastEmitted = useRef(hex);
  useEffect(() => {
    if (hex !== lastEmitted.current) setHsv(hexToHsv(hex));
  }, [hex]);

  const emit = useCallback(
    (next: Hsv) => {
      setHsv(next);
      const h = hsvToHex(next);
      lastEmitted.current = h;
      onChange(h);
    },
    [onChange],
  );

  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  // Ref mirror so drag handlers read fresh hsv without re-binding.
  const hsvRef = useRef(hsv);
  hsvRef.current = hsv;

  const pickSv = useCallback(
    (e: React.PointerEvent) => {
      const rect = svRef.current!.getBoundingClientRect();
      const s = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const v =
        1 - Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
      emit({ ...hsvRef.current, s, v });
    },
    [emit],
  );
  const pickHue = useCallback(
    (e: React.PointerEvent) => {
      const rect = hueRef.current!.getBoundingClientRect();
      const h =
        360 * Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      emit({ ...hsvRef.current, h: Math.min(h, 359.9) });
    },
    [emit],
  );

  const dragHandlers = (pick: (e: React.PointerEvent) => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      pick(e);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (e.buttons & 1) pick(e);
    },
  });

  return (
    <div className="space-y-2">
      {/* saturation/value square */}
      <div
        ref={svRef}
        {...dragHandlers(pickSv)}
        style={{
          position: "relative",
          height: 150,
          cursor: "crosshair",
          touchAction: "none",
          backgroundColor: `hsl(${hsv.h} 100% 50%)`,
          backgroundImage:
            "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            width: 12,
            height: 12,
            marginLeft: -6,
            marginTop: -6,
            borderRadius: "50%",
            pointerEvents: "none",
            boxShadow: "0 0 0 2px #fff, 0 0 0 3.5px rgba(0,0,0,0.45)",
          }}
        />
      </div>
      {/* hue strip */}
      <div
        ref={hueRef}
        {...dragHandlers(pickHue)}
        style={{
          position: "relative",
          height: 16,
          cursor: "crosshair",
          touchAction: "none",
          background: HUE_GRADIENT,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: `${(hsv.h / 360) * 100}%`,
            top: -2,
            width: 4,
            height: 20,
            marginLeft: -2,
            pointerEvents: "none",
            background: "#fff",
            boxShadow: "0 0 0 2px rgba(0,0,0,0.45)",
          }}
        />
      </div>
    </div>
  );
}

// ── the panel ────────────────────────────────────────────────────────────────

export function PalettePanel() {
  const { isOpen, overrides, open, close, setColor, resetColor, resetAll } =
    usePaletteDevtool();
  const [selected, setSelected] = useState<string | null>(null);
  const [hexDraft, setHexDraft] = useState("");
  const [copied, setCopied] = useState(false);
  // null → default top-right placement; set once the header is dragged.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragStart = useRef<{ px: number; py: number; x: number; y: number } | null>(
    null,
  );
  const panelRef = useRef<HTMLDivElement>(null);

  // Operator-only entry (GLASSHOUSE-AND-PALETTE-ADR §III.5): there is no shipped
  // menu/settings row anymore. The panel is reachable two ways — a `?palette`
  // query param (deep-linkable) or the Ctrl+Alt+P chord (toggle). Boot-time
  // hydration of persisted overrides lives in the headless PaletteHydrator, not
  // here, so it runs even when this panel never opens.
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).has("palette")) open();
    } catch {
      /* ignore malformed search */
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        const s = usePaletteDevtool.getState();
        if (s.isOpen) s.close();
        else s.open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const currentHex = useCallback(
    (entry: PaletteEntry) => overrides[entry.slug] ?? entry.hex,
    [overrides],
  );

  if (!isOpen) return null;

  const selectedEntry = PALETTE_REGISTRY.find((e) => e.slug === selected);

  const listText = PALETTE_REGISTRY.map(
    (e, i) =>
      `${String(i + 1).padStart(2, "0")} ${currentHex(e)} ${e.slug}`,
  ).join("\n");

  const startDrag = (e: React.PointerEvent) => {
    const rect = panelRef.current!.getBoundingClientRect();
    dragStart.current = {
      px: e.clientX,
      py: e.clientY,
      x: rect.left,
      y: rect.top,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: React.PointerEvent) => {
    if (!dragStart.current || !(e.buttons & 1)) return;
    const { px, py, x, y } = dragStart.current;
    setPos({
      x: Math.min(
        Math.max(8 - 300, x + e.clientX - px),
        window.innerWidth - 60,
      ),
      y: Math.min(Math.max(8, y + e.clientY - py), window.innerHeight - 40),
    });
  };

  return (
    <div
      ref={panelRef}
      style={{
        position: "fixed",
        ...(pos ? { left: pos.x, top: pos.y } : { right: 24, top: 24 }),
        zIndex: 200,
        width: 340,
        maxHeight: "calc(100vh - 48px)",
        display: "flex",
        flexDirection: "column",
        background: "#FFFFFF",
        boxShadow: "0 8px 40px rgba(0,0,0,0.30)",
      }}
    >
      {/* header — drag handle */}
      <div
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        className="label-ui"
        style={{
          padding: "14px 48px 10px 16px",
          color: "#666666",
          cursor: "move",
          userSelect: "none",
          touchAction: "none",
          flexShrink: 0,
        }}
      >
        Palette — live tuning
        {Object.keys(overrides).length > 0 &&
          ` (${Object.keys(overrides).length} changed)`}
      </div>
      <button
        type="button"
        aria-label="Close palette"
        onClick={close}
        className="text-grey-400 hover:text-black"
        style={{
          position: "absolute",
          right: 12,
          top: 10,
          fontSize: 18,
          lineHeight: 1,
          padding: 4,
          background: "none",
          border: "none",
          cursor: "pointer",
        }}
      >
        ✕
      </button>

      {/* body */}
      <div style={{ overflowY: "auto", padding: "0 16px 16px" }}>
        {/* swatch grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(6, 1fr)",
            gap: 6,
          }}
        >
          {PALETTE_REGISTRY.map((entry, i) => {
            const hex = currentHex(entry);
            const isSel = selected === entry.slug;
            return (
              <button
                key={entry.slug}
                type="button"
                title={`${String(i + 1).padStart(2, "0")} ${entry.slug} — ${entry.label}`}
                onClick={() => {
                  setSelected(isSel ? null : entry.slug);
                  setHexDraft("");
                }}
                className="font-mono"
                style={{
                  height: 34,
                  border: "none",
                  cursor: "pointer",
                  background: hex,
                  fontSize: 9,
                  color: luminance(hex) > 0.55 ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.75)",
                  boxShadow: isSel
                    ? "0 0 0 2px #FFFFFF, 0 0 0 4px #111111"
                    : "inset 0 0 0 2px rgba(0,0,0,0.08)",
                }}
              >
                {String(i + 1).padStart(2, "0")}
              </button>
            );
          })}
        </div>

        {/* picker for the selected colour */}
        {selectedEntry && (
          <div className="mt-4 space-y-2">
            <div className="label-ui" style={{ color: "#111111" }}>
              {String(
                PALETTE_REGISTRY.indexOf(selectedEntry) + 1,
              ).padStart(2, "0")}{" "}
              {selectedEntry.slug} · {currentHex(selectedEntry)}
            </div>
            <p
              className="font-sans"
              style={{ fontSize: 12, lineHeight: 1.4, color: "#666666", margin: 0 }}
            >
              {selectedEntry.label}
            </p>
            <SpectrumPicker
              hex={currentHex(selectedEntry)}
              onChange={(hex) => setColor(selectedEntry.slug, hex)}
            />
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <input
                type="text"
                value={hexDraft}
                placeholder={currentHex(selectedEntry)}
                onChange={(e) => {
                  setHexDraft(e.target.value);
                  const hex = normalizeHex(e.target.value);
                  if (hex) setColor(selectedEntry.slug, hex);
                }}
                className="font-mono"
                spellCheck={false}
                style={{
                  width: 90,
                  fontSize: 12,
                  padding: "4px 8px",
                  background: "#F0F0F0",
                  border: "none",
                  outline: "none",
                }}
              />
              {overrides[selectedEntry.slug] &&
                overrides[selectedEntry.slug] !== selectedEntry.hex && (
                  <button
                    type="button"
                    className="btn-text-muted"
                    onClick={() => {
                      resetColor(selectedEntry.slug);
                      setHexDraft("");
                    }}
                  >
                    Reset to {selectedEntry.hex}
                  </button>
                )}
            </div>
          </div>
        )}

        {/* canonical list */}
        <pre
          className="font-mono mt-4"
          style={{
            fontSize: 11,
            lineHeight: 1.7,
            margin: 0,
            padding: "10px 12px",
            background: "#F0F0F0",
            color: "#111111",
            overflowX: "auto",
            userSelect: "all",
          }}
        >
          {listText}
        </pre>

        {/* actions */}
        <div
          className="mt-3"
          style={{ display: "flex", gap: 16, alignItems: "center" }}
        >
          <button
            type="button"
            className="btn-text"
            onClick={() => {
              navigator.clipboard
                .writeText(listText)
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
                .catch(() => {});
            }}
          >
            {copied ? "Copied ✓" : "Copy list"}
          </button>
          {Object.keys(overrides).length > 0 && (
            <button type="button" className="btn-text-danger" onClick={resetAll}>
              Reset all
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
