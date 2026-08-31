'use client'

import { useRef, useState, useEffect, useMemo, useCallback } from 'react'
import type { HalfDayBucket } from '../../lib/traffology-api'

// =============================================================================
// ProvenanceBar — op-art IKB bar for a single source
//
// Renders half-day buckets as alternating stripes of IKB blue (day) and
// background (night). Width proportional to traffic volume, newest at left.
// Hovering shows the date in a readout callback.
// =============================================================================


interface ProvenanceBarProps {
  buckets: HalfDayBucket[]
  height: number
  onHoverInfo?: (info: string | null) => void
}

export function ProvenanceBar({ buckets, height, onHoverInfo }: ProvenanceBarProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)

  // Sort buckets newest first (left edge)
  const sorted = useMemo(
    () => [...buckets].sort((a, b) =>
      new Date(b.bucket_start).getTime() - new Date(a.bucket_start).getTime()
    ),
    [buckets]
  )

  const totalCount = useMemo(
    () => sorted.reduce((s, b) => s + b.reader_count, 0),
    [sorted]
  )

  // Cumulative fractions for hover lookup
  const cumFracs = useMemo(() => {
    if (totalCount === 0) return []
    let cum = 0
    return sorted.map(b => {
      cum += b.reader_count / totalCount
      return cum
    })
  }, [sorted, totalCount])

  // Measure width
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const measure = () => setWidth(el.offsetWidth)
    measure()
    const obs = new ResizeObserver(measure)
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width <= 0 || totalCount === 0) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)

    // Canvas can't resolve var() — read the live triples off :root at draw
    // time so the bar tracks the canonical palette (registry: klein-blue /
    // off-white).
    const rootStyle = getComputedStyle(document.documentElement)
    const bg = `rgb(${rootStyle.getPropertyValue('--ah-off-white-rgb')})`
    const ikb = `rgb(${rootStyle.getPropertyValue('--ah-klein-blue-rgb')})`

    ctx.fillStyle = bg
    ctx.fillRect(0, 0, width, height)

    let x = 0
    for (const bucket of sorted) {
      const bw = (bucket.reader_count / totalCount) * width
      if (bucket.is_day && bw >= 0.4) {
        const x0 = Math.round(x)
        const x1 = Math.round(x + bw)
        ctx.fillStyle = ikb
        ctx.fillRect(x0, 0, Math.max(x1 - x0, 1), height)
      }
      x += bw
    }
  }, [sorted, totalCount, width, height])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!onHoverInfo || totalCount === 0 || sorted.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = (e.clientX - rect.left) / rect.width

    let lo = 0, hi = cumFracs.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cumFracs[mid] < frac) lo = mid + 1
      else hi = mid
    }

    const bucket = sorted[lo]
    if (!bucket) return
    const d = new Date(bucket.bucket_start)
    const dateStr = d.toLocaleDateString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short',
    })
    onHoverInfo(`${dateStr} \u00b7 ${bucket.is_day ? 'day' : 'night'}`)
  }, [sorted, cumFracs, totalCount, onHoverInfo])

  return (
    <div ref={wrapperRef} style={{ width: '100%', height }}>
      {width > 0 && (
        <canvas
          ref={canvasRef}
          style={{ width, height, display: 'block', cursor: 'crosshair', touchAction: 'none' }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => onHoverInfo?.(null)}
        />
      )}
    </div>
  )
}
