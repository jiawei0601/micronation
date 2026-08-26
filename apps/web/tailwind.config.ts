import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        chart: {
          bg: '#0b1d2a',
          panel: '#161b24',
          panel2: '#0e1117',
          border: '#24455e',
          accent: '#8fd0ff',
          blue: '#4c8dff',
          gold: '#c9a227',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
