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
        ink: {
          50: '#f6f7f9',
          100: '#eceef2',
          200: '#d4d9e1',
          300: '#aeb7c6',
          400: '#8290a5',
          500: '#637189',
          600: '#4e5a70',
          700: '#40495b',
          800: '#373e4d',
          900: '#1f242e',
          950: '#13161c',
        },
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
