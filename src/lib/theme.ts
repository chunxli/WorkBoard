export type ColorTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "workboard-theme";

export function resolveColorTheme(
  storedTheme: string | null,
  prefersLight: boolean
): ColorTheme {
  if (storedTheme === "light" || storedTheme === "dark") return storedTheme;
  return prefersLight ? "light" : "dark";
}

export function nextColorTheme(currentTheme: string | undefined): ColorTheme {
  return currentTheme === "light" ? "dark" : "light";
}

export const THEME_INITIALIZER = `(() => {
  try {
    const stored = localStorage.getItem("${THEME_STORAGE_KEY}");
    const theme = stored === "light" || stored === "dark"
      ? stored
      : matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch {
    document.documentElement.dataset.theme = "dark";
  }
})();`;