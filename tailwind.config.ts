import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // `trust` is kept as a legacy alias for `primary` so the ~140
        // pre-existing usages across the app re-theme automatically to the
        // new design system's primary-action blue, without a mass rename.
        // Prefer `primary` in new code.
        trust: { DEFAULT: '#2563EB', 700: '#1D4ED8' },
        primary: { DEFAULT: '#2563EB', 700: '#1D4ED8' },
        // `progress` kept as a legacy alias for `positive`; prefer `positive`.
        progress: { DEFAULT: '#198754' },
        positive: { DEFAULT: '#198754' },
        // `caution` kept as a legacy alias for `attention`; prefer `attention`.
        caution: { DEFAULT: '#B7791F' },
        attention: { DEFAULT: '#B7791F' },
        risk: { DEFAULT: '#C7362F' },
        ai: { DEFAULT: '#6D5BD0' },
        nav: { DEFAULT: '#0F2747' },
        app: { DEFAULT: '#F5F7FA' },
        line: { DEFAULT: '#DDE3EA' },
        ink: { DEFAULT: '#172033' },
        muted: { DEFAULT: '#5B677A' },
      },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      borderRadius: { card: '0.75rem', hero: '1rem', compact: '0.5rem' },
    },
  },
  plugins: [],
} satisfies Config;
