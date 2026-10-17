import { readJSON, writeJSON } from "./storage";

export type ThemeChoice = "light" | "dark" | "system";
export type EditorSize = "small" | "medium" | "large";
export type Palette = "navy" | "plum";

const SIZES: Record<EditorSize, string> = { small: "1rem", medium: "1.125rem", large: "1.3rem" };

export function getTheme(): ThemeChoice {
  return readJSON<ThemeChoice>("theme", "system");
}

export function getEditorSize(): EditorSize {
  return readJSON<EditorSize>("editor-size", "medium");
}

export function getPalette(): Palette {
  return readJSON<Palette>("palette", "navy");
}

const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

export function applyTheme(choice = getTheme()): void {
  const dark = choice === "dark" || (choice === "system" && !!media?.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.palette = getPalette();
  document.documentElement.style.setProperty("--editor-size", SIZES[getEditorSize()]);
}

export function setTheme(choice: ThemeChoice): void {
  writeJSON("theme", choice);
  applyTheme(choice);
}

export function setPalette(palette: Palette): void {
  writeJSON("palette", palette);
  applyTheme();
}

export function setEditorSize(size: EditorSize): void {
  writeJSON("editor-size", size);
  applyTheme();
}

/** Ctrl+Shift+L: flips between light and dark. */
export function toggleTheme(): void {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}

media?.addEventListener("change", () => applyTheme());
