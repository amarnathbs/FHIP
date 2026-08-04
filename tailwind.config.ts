import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        trust: { DEFAULT: '#1F4E79', 700: '#163a5c' },
        progress: { DEFAULT: '#0E9F8E' },
        caution: { DEFAULT: '#D98A00' },
        risk: { DEFAULT: '#C0392B' },
      },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      borderRadius: { card: '0.75rem' },
    },
  },
  plugins: [],
} satisfies Config;
