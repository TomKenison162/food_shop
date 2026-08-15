import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        tier: {
          budget: "#2f9e5b",
          standard: "#c98a1d",
          gourmet: "#8a3ffc",
        },
      },
    },
  },
  plugins: [],
};

export default config;
