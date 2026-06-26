import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        ink: {
          950: "#070b14",
          900: "#0b1120",
          850: "#0f172a",
          800: "#131c31",
          700: "#1e293b",
        },
        brand: {
          50: "#eef2ff",
          300: "#a5b4fc",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
        },
        accent: {
          cyan: "#22d3ee",
          emerald: "#34d399",
          amber: "#fbbf24",
          rose: "#fb7185",
        },
      },
      keyframes: {
        "pulse-line": {
          "0%": { strokeDashoffset: "24" },
          "100%": { strokeDashoffset: "0" },
        },
        float: {
          "0%,100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-6px)" },
        },
      },
      animation: {
        "pulse-line": "pulse-line 1s linear infinite",
        float: "float 5s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
