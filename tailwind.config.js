/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Stonowany teal (styl "Frosted") + neutralne, szare tlo studia
        brand: {
          50: '#eef6f3',
          100: '#e0efea',
          200: '#c0dfd5',
          300: '#90c6b6',
          400: '#58a994',
          500: '#2f8f7a',
          600: '#277a68',
          700: '#1f6b5a',
          800: '#1b564a',
          900: '#17463d',
          950: '#0a2a24',
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
        sans: ['Figtree', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      borderRadius: {
        // Karty i okna w stylu "Frosted" sa wyraznie zaokraglone (18px).
        '2xl': '18px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,.04)',
        // Wybrany element kontrolki segmentowej / aktywna pozycja menu.
        seg: '0 1px 3px rgba(0,0,0,.08)',
        pop: '0 12px 32px rgba(0,0,0,.14)',
      },
    },
  },
  plugins: [],
}
