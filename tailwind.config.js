/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#0F0F11",
        surface: "#1A1A1F",
        card: "#22222A",
        border: "#2E2E38",
        accentViolet: "#8B5CF6",
        accentBlue: "#3B82F6",
        textPrimary: "#F1F0F5",
        textSecondary: "#8B8A96",
        success: "#10B981",
        warning: "#F59E0B",
        error: "#EF4444",
      },
      backgroundImage: {
        'accent-gradient': 'linear-gradient(135deg, #8B5CF6 0%, #3B82F6 100%)',
        'dark-glow': 'radial-gradient(circle at center, rgba(139, 92, 246, 0.15) 0%, transparent 70%)',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        display: ['Outfit', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'shimmer': 'shimmer 2.5s linear infinite',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        }
      }
    },
  },
  plugins: [],
}
