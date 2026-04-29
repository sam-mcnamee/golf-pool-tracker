import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        club: {
          navy: "#1a2b3c",
          cream: "#fdf5e6",
          gold: "#c5a059"
        }
      },
      container: {
        center: true,
        padding: "2rem",
        screens: {
          "2xl": "1400px"
        }
      }
    }
  },
  plugins: []
} satisfies Config;

