import typography from "@tailwindcss/typography";
import type { Config } from "tailwindcss";

const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        paper: token("paper"),
        surface: token("surface"),
        ink: token("ink"),
        muted: token("muted"),
        line: token("line"),
        accent: token("accent"),
        "accent-soft": token("accent-soft"),
        "accent-strong": token("accent-strong"),
        "on-accent": token("on-accent"),
        warn: token("warn"),
        "warn-soft": token("warn-soft"),
        danger: token("danger"),
      },
      fontFamily: {
        serif: ['"Source Serif 4 Variable"', "Georgia", "Cambria", "serif"],
        sans: ['"Figtree Variable"', "system-ui", "-apple-system", '"Segoe UI"', "Roboto", "sans-serif"],
      },
      maxWidth: { prose: "68ch" },
    },
  },
  plugins: [typography],
} satisfies Config;
