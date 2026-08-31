import type { Metadata } from 'next'
import './globals.css'
import { AuthProvider } from '../components/layout/AuthProvider'
import { LayoutShell } from '../components/layout/LayoutShell'

export const metadata: Metadata = {
  title: 'all.haus',
  description: 'A publishing platform for writers and readers',
  metadataBase: new URL('https://all.haus'),
  openGraph: {
    title: 'all.haus',
    description: 'A publishing platform for writers and readers',
    siteName: 'all.haus',
    type: 'website',
    url: 'https://all.haus',
  },
  twitter: {
    card: 'summary',
    title: 'all.haus',
    description: 'A publishing platform for writers and readers',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        {/* No-FOUC: set html.dark before paint so dark-mode users never see a
            white flash. Mirrors useColorScheme (web/src/stores/colorScheme.ts);
            the ColorSchemeHydrator reconciles store state + the live listener. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var m=localStorage.getItem('ah:color-mode')||'light';var d=m==='dark'||(m==='system'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);var e=document.documentElement;e.classList.toggle('dark',d);e.style.colorScheme=d?'dark':'light';}catch(_){}})();",
          }}
        />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="icon" href="/icon-32.png" type="image/png" sizes="32x32" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="preload" href="/fonts/jost-latin.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/literata-latin-400.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/literata-latin-400-italic.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/ibm-plex-mono-latin-400.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link
          rel="alternate"
          type="application/rss+xml"
          title="all.haus — recent articles"
          href="/rss"
        />
      </head>
      <body>
        <AuthProvider>
          <LayoutShell>{children}</LayoutShell>
        </AuthProvider>
      </body>
    </html>
  )
}
