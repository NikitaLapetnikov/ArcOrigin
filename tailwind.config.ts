import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        ink: "#060811",
        panel: "#0b101c",
        line: "#1c2535",
        cyan: "#39bdf8",
        violet: "#7567ff",
      },
      fontFamily: {
        sans: ["Manrope Variable", "Manrope", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono Variable", "JetBrains Mono", "ui-monospace", "monospace"],
      },
      boxShadow: {
        glow: "0 18px 50px rgba(0,0,0,.26), 0 1px 0 rgba(255,255,255,.025) inset",
      },
    },
  },
  plugins: [],
} satisfies Config;
