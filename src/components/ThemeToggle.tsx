"use client";

import { Moon, Sun } from "lucide-react";
import { nextColorTheme, THEME_STORAGE_KEY } from "@/lib/theme";

export default function ThemeToggle() {
  function toggleTheme() {
    const root = document.documentElement;
    const theme = nextColorTheme(root.dataset.theme);
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label="Toggle light and dark theme"
      title="Toggle light and dark theme"
      className="theme-toggle grid size-9 place-items-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-white"
    >
      <Sun size={16} className="theme-icon-light" aria-hidden="true" />
      <Moon size={16} className="theme-icon-dark" aria-hidden="true" />
    </button>
  );
}