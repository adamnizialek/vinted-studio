/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Paleta inspirowana Vinted (teal) + neutralne tlo studia
        brand: {
          50: '#e8faf6',
          100: '#c8f3e9',
          200: '#92e7d3',
          300: '#54d4ba',
          400: '#23b89c',
          500: '#0b9b82',
          600: '#067d6a',
          700: '#096457',
          800: '#0b5046',
          900: '#0c423b',
          950: '#022621',
        },
        // Neutralna rampa "ink" jest sterowana zmiennymi CSS, by motyw mogl sie
        // odwracac w jednym bloku @media (prefers-color-scheme: dark) — patrz index.css.
        // Wartosci to kanaly RGB ("R G B"), dzieki czemu modyfikatory przezroczystosci
        // (np. bg-ink-100/60) dzialaja przez rgb(var(--x) / <alpha-value>).
        ink: {
          50: 'rgb(var(--ink-50) / <alpha-value>)',
          100: 'rgb(var(--ink-100) / <alpha-value>)',
          200: 'rgb(var(--ink-200) / <alpha-value>)',
          300: 'rgb(var(--ink-300) / <alpha-value>)',
          400: 'rgb(var(--ink-400) / <alpha-value>)',
          500: 'rgb(var(--ink-500) / <alpha-value>)',
          600: 'rgb(var(--ink-600) / <alpha-value>)',
          700: 'rgb(var(--ink-700) / <alpha-value>)',
          800: 'rgb(var(--ink-800) / <alpha-value>)',
          900: 'rgb(var(--ink-900) / <alpha-value>)',
          950: 'rgb(var(--ink-950) / <alpha-value>)',
        },
        // Powierzchnia "kartowa" — w jasnym motywie biala, w ciemnym podniesiony panel.
        surface: 'rgb(var(--surface) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.08)',
        pop: '0 12px 32px rgba(16,24,40,.16)',
      },
    },
  },
  plugins: [],
}
