/**
 * Dense internal tooling, not a marketing site. The scale below is tightened
 * accordingly: the default text size is 13px, not 16px, because these tables
 * are read all day and vertical space is the scarcest thing on the screen.
 */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
        xs: ['0.75rem', { lineHeight: '1.05rem' }],
        sm: ['0.8125rem', { lineHeight: '1.15rem' }],
        base: ['0.875rem', { lineHeight: '1.25rem' }],
      },
      colors: {
        // Red is BLOCK and amber is WARN. Nothing else may use them —
        // colour-coding by supplier or category would make the one signal
        // that matters invisible.
        block: { DEFAULT: '#b42318', bg: '#fef3f2', border: '#fecdca' },
        warn: { DEFAULT: '#b54708', bg: '#fffaeb', border: '#fedf89' },
        ok: { DEFAULT: '#067647', bg: '#ecfdf3', border: '#abefc6' },
      },
    },
  },
  plugins: [],
};
