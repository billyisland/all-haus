// =============================================================================
// Traffology page script — reader session tracking
//
// Injected on article pages. Captures scroll depth, active reading time,
// referrer, UTM params, and subscriber status. Sends data via sendBeacon
// to /ingest/beacon. No cookies, no fingerprinting, no third-party calls.
//
// Target: <5KB gzipped (actual: ~1.5KB gzipped)
// =============================================================================

;(function traffology() {
  if (typeof window === 'undefined' || !navigator.sendBeacon) return

  const BEACON_URL = '/ingest/beacon'
  const HEARTBEAT_MS = 30_000
  const IDLE_TIMEOUT_MS = 30_000
  const SCROLL_THROTTLE_MS = 200

  // Read article ID from data attribute
  const el = document.querySelector('[data-traffology-article-id]')
  if (!el) return
  const articleId = el.getAttribute('data-traffology-article-id')
  if (!articleId) return

  // Session token: per-tab, per-article, stored in sessionStorage
  const storageKey = 'traf_' + articleId
  let sessionToken = sessionStorage.getItem(storageKey)
  if (!sessionToken) {
    sessionToken = crypto.randomUUID()
    sessionStorage.setItem(storageKey, sessionToken)
  }

  // State
  let maxScrollDepth = 0
  let activeSeconds = 0
  let lastActiveTime = Date.now()
  let isActive = true
  let scrollTimer: ReturnType<typeof setTimeout> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

  // --- Helpers ---

  function getSubscriberStatus(): string {
    const subEl = document.querySelector('[data-traffology-subscriber]')
    return subEl?.getAttribute('data-traffology-subscriber') || 'anonymous'
  }

  function getUtm(): Record<string, string | undefined> {
    const p = new URLSearchParams(window.location.search)
    return {
      utmSource: p.get('utm_source') || undefined,
      utmMedium: p.get('utm_medium') || undefined,
      utmCampaign: p.get('utm_campaign') || undefined,
    }
  }

  // --- Scroll depth ---

  function updateScrollDepth() {
    const scrollTop = window.scrollY || document.documentElement.scrollTop
    const docHeight = document.documentElement.scrollHeight - window.innerHeight
    if (docHeight > 0) {
      const depth = Math.min(1, scrollTop / docHeight)
      if (depth > maxScrollDepth) maxScrollDepth = depth
    }
  }

  window.addEventListener('scroll', () => {
    if (!scrollTimer) {
      scrollTimer = setTimeout(() => {
        updateScrollDepth()
        scrollTimer = null
      }, SCROLL_THROTTLE_MS)
    }
  }, { passive: true })

  // --- Active reading time ---

  function markActive() {
    if (!isActive) {
      isActive = true
      lastActiveTime = Date.now()
    }
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(markIdle, IDLE_TIMEOUT_MS)
  }

  function markIdle() {
    if (isActive) {
      activeSeconds += Math.round((Date.now() - lastActiveTime) / 1000)
      isActive = false
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) markIdle()
    else markActive()
  })

  const activityEvents = ['scroll', 'click', 'keydown', 'mousemove', 'touchstart']
  activityEvents.forEach(evt =>
    document.addEventListener(evt, markActive, { passive: true }),
  )

  // --- Beacon sending ---

  function send(type: 'init' | 'heartbeat' | 'unload') {
    // Snapshot active time
    if (isActive) {
      activeSeconds += Math.round((Date.now() - lastActiveTime) / 1000)
      lastActiveTime = Date.now()
    }

    const payload: Record<string, unknown> = {
      sessionToken,
      articleId,
      type,
      timestamp: Date.now(),
      scrollDepth: Math.round(maxScrollDepth * 1000) / 1000,
      readingTimeSeconds: activeSeconds,
    }

    if (type === 'init') {
      payload.referrerUrl = document.referrer || undefined
      payload.screenWidth = window.innerWidth
      payload.subscriberStatus = getSubscriberStatus()
      Object.assign(payload, getUtm())
    }

    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
    navigator.sendBeacon(BEACON_URL, blob)
  }

  // --- Lifecycle ---

  updateScrollDepth()
  markActive()
  send('init')

  heartbeatTimer = setInterval(() => send('heartbeat'), HEARTBEAT_MS)

  // Send unload when tab becomes hidden (more reliable than beforeunload)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      send('unload')
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
    } else if (!heartbeatTimer) {
      // Tab became visible again — resume heartbeats
      send('heartbeat')
      heartbeatTimer = setInterval(() => send('heartbeat'), HEARTBEAT_MS)
    }
  })

  // Fallback for older browsers
  window.addEventListener('pagehide', () => send('unload'))
})()
