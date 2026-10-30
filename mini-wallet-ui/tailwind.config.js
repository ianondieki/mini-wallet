/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#08080d',
        surface: '#0f0f16',
        'surface-2': '#15151f',
        'surface-3': '#1a1a26',
        border: '#23233a',
        'border-strong': '#2e2e48',
        primary: {
          DEFAULT: '#f5a623',
          dim: '#d98c1a',
          soft: 'rgba(245,166,35,0.12)',
        },
        secondary: '#e85d75',
        accent: '#fbbf24',
        'text-primary': '#f4f4f8',
        'text-secondary': '#c4c4d4',
        'text-muted': '#8b8ba3',
        success: '#34d399',
        error: '#f87171',
        warning: '#fbbf24',
        info: '#60a5fa',
      },
      fontFamily: {
        sans: ['"Inter"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.02em' }],
        display: ['2.75rem', { lineHeight: '1.1', letterSpacing: '-0.03em', fontWeight: '700' }],
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.25rem',
        '3xl': '1.5rem',
      },
      boxShadow: {
        'glow-primary':
          '0 0 0 1px rgba(245,166,35,0.28), 0 0 28px -8px rgba(245,166,35,0.35)',
        'glow-secondary':
          '0 0 0 1px rgba(232,93,117,0.28), 0 0 24px -8px rgba(232,93,117,0.3)',
        card: '0 4px 24px -8px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.03)',
        elevated:
          '0 12px 40px -12px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.04)',
        soft: '0 2px 12px -4px rgba(0,0,0,0.4)',
      },
      letterSpacing: {
        money: '-0.02em',
      },
      spacing: {
        18: '4.5rem',
      },
      keyframes: {
        'drift-1': {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)', opacity: '0.35' },
          '50%': { transform: 'translate(40px, -28px) scale(1.08)', opacity: '0.5' },
        },
        'drift-2': {
          '0%, 100%': { transform: 'translate(0, 0) scale(1.05)', opacity: '0.3' },
          '50%': { transform: 'translate(-36px, 36px) scale(0.96)', opacity: '0.45' },
        },
        'drift-3': {
          '0%, 100%': { transform: 'translate(0, 0) scale(0.95)', opacity: '0.25' },
          '50%': { transform: 'translate(28px, 40px) scale(1.06)', opacity: '0.4' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        'pulse-glow': {
          '0%, 100%': {
            boxShadow:
              '0 0 0 1px rgba(245,166,35,0.22), 0 0 32px -10px rgba(245,166,35,0.25)',
          },
          '50%': {
            boxShadow:
              '0 0 0 1px rgba(245,166,35,0.4), 0 0 48px -8px rgba(245,166,35,0.4)',
          },
        },
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
      animation: {
        'drift-1': 'drift-1 18s ease-in-out infinite',
        'drift-2': 'drift-2 22s ease-in-out infinite',
        'drift-3': 'drift-3 16s ease-in-out infinite',
        shimmer: 'shimmer 1.6s infinite',
        'pulse-glow': 'pulse-glow 5s ease-in-out infinite',
        'fade-up': 'fade-up 0.4s ease-out',
        'fade-in': 'fade-in 0.35s ease-out',
      },
    },
  },
  plugins: [],
};
