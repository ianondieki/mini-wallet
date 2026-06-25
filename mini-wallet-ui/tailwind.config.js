/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0a0f',
        surface: '#111118',
        'surface-2': '#16161f',
        border: '#1e1e2e',
        primary: {
          DEFAULT: '#f5a623',
          dim: '#d98c1a',
        },
        secondary: '#f43f5e',
        accent: '#fbbf24',
        'text-primary': '#f1f5f9',
        'text-muted': '#64748b',
        success: '#10b981',
        error: '#ef4444',
        warning: '#f59e0b',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.25rem',
      },
      boxShadow: {
        'glow-primary': '0 0 0 1px rgba(245,166,35,0.4), 0 0 24px -4px rgba(245,166,35,0.35)',
        'glow-secondary': '0 0 0 1px rgba(244,63,94,0.4), 0 0 24px -4px rgba(244,63,94,0.35)',
        card: '0 8px 40px -12px rgba(0,0,0,0.6)',
      },
      keyframes: {
        'drift-1': {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)', opacity: '0.55' },
          '50%': { transform: 'translate(60px, -40px) scale(1.15)', opacity: '0.8' },
        },
        'drift-2': {
          '0%, 100%': { transform: 'translate(0, 0) scale(1.1)', opacity: '0.5' },
          '50%': { transform: 'translate(-50px, 50px) scale(0.95)', opacity: '0.75' },
        },
        'drift-3': {
          '0%, 100%': { transform: 'translate(0, 0) scale(0.9)', opacity: '0.45' },
          '50%': { transform: 'translate(40px, 60px) scale(1.1)', opacity: '0.7' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 0 1px rgba(245,166,35,0.35), 0 0 28px -6px rgba(245,166,35,0.3)' },
          '50%': { boxShadow: '0 0 0 1px rgba(245,166,35,0.6), 0 0 44px -4px rgba(245,166,35,0.55)' },
        },
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'drift-1': 'drift-1 11s ease-in-out infinite',
        'drift-2': 'drift-2 13s ease-in-out infinite',
        'drift-3': 'drift-3 9s ease-in-out infinite',
        shimmer: 'shimmer 1.6s infinite',
        'pulse-glow': 'pulse-glow 4s ease-in-out infinite',
        'fade-up': 'fade-up 0.4s ease-out',
      },
    },
  },
  plugins: [],
};
