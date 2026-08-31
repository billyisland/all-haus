/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Jost"', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        serif: ['"Literata"', 'Georgia', '"Times New Roman"', 'serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', '"SF Mono"', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        // All token values live as RGB-triple CSS vars in globals.css :root
        // (canonical list: web/src/lib/palette/registry.ts) so the Palette
        // devtool can retune them live; <alpha-value> keeps /40-style washes.
        white: 'rgb(var(--ah-white-rgb) / <alpha-value>)',
        black: 'rgb(var(--ah-ink-rgb) / <alpha-value>)',
        grey: {
          100: 'rgb(var(--ah-grey-100-rgb) / <alpha-value>)',
          200: 'rgb(var(--ah-grey-200-rgb) / <alpha-value>)',
          300: 'rgb(var(--ah-grey-300-rgb) / <alpha-value>)',
          400: 'rgb(var(--ah-grey-400-rgb) / <alpha-value>)',
          600: 'rgb(var(--ah-grey-600-rgb) / <alpha-value>)',
        },
        crimson: {
          DEFAULT: 'rgb(var(--ah-crimson-rgb) / <alpha-value>)',
          dark: 'rgb(var(--ah-crimson-dark-rgb) / <alpha-value>)',
        },
        // Glasshouse pane fill — the overlay interior, now the LIGHTEST surface
        // (white) so it reads as the outermost layer and nested wells sit a touch
        // darker inside it. `glasshouse-well` (#F5F4F0) is that inset field/well
        // colour — the two were swapped (the pane used to be the parchment and
        // fields the white well; flipped so the lightest is outermost). Fixed
        // (does not track brightness); text stays dark. See the Glasshouse
        // design-system rule in CLAUDE.md.
        glasshouse: 'rgb(var(--ah-glasshouse-rgb) / <alpha-value>)',
        'glasshouse-well': 'rgb(var(--ah-glasshouse-well-rgb) / <alpha-value>)',
      },
      typography: {
        DEFAULT: {
          css: {
            maxWidth: '640px',
            fontSize: '1.0625rem',
            lineHeight: '1.8',
            color: 'var(--ah-ink)',
            fontFamily: '"Literata", Georgia, serif',
            h1: { fontFamily: '"Literata", Georgia, serif', fontWeight: '500', letterSpacing: '-0.025em', fontSize: '2.25rem', lineHeight: '1.15' },
            h2: { fontFamily: '"Literata", Georgia, serif', fontWeight: '500', letterSpacing: '-0.02em', fontSize: '1.75rem', lineHeight: '1.2' },
            h3: { fontFamily: '"Literata", Georgia, serif', fontWeight: '500', fontSize: '1.35rem', lineHeight: '1.3' },
            a: { color: 'var(--ah-ink)', textDecoration: 'underline', textUnderlineOffset: '3px', textDecorationThickness: '1px', '&:hover': { color: 'var(--ah-grey-600)' } },
            blockquote: { borderLeftColor: 'var(--ah-grey-300)', borderLeftWidth: '4px', fontStyle: 'italic', color: 'var(--ah-grey-600)' },
            code: { fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace', fontSize: '0.875em' },
            p: { marginTop: '1.5em', marginBottom: '1.5em' },
          },
        },
      },
      maxWidth: {
        article: '640px',
        'article-frame': '960px',
        feed: '780px',
        'editor-frame': '780px',
        content: '960px',
      },
      letterSpacing: {
        'mono-nav': '0.06em',
        'mono-byline': '0.06em',
        'mono-meta': '0.02em',
      },
      fontSize: {
        'mono-xs': ['0.6875rem', { lineHeight: '1.5', letterSpacing: '0.06em' }],
        'mono-sm': ['0.9375rem', { lineHeight: '1.5', letterSpacing: '0.01em' }],
        'ui-xs': ['0.8125rem', { lineHeight: '1.5' }],
        'ui-sm': ['0.875rem', { lineHeight: '1.5' }],
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
