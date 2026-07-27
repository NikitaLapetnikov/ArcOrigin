"use client";

import { useCallback, useEffect, useState } from "react";

export type SiteTheme = "dark" | "light";

const THEME_EVENT = "arcorigin:theme";
const STORAGE_KEY = "arcorigin-theme";

function currentTheme(): SiteTheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function applySiteTheme(theme: SiteTheme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  window.localStorage.setItem(STORAGE_KEY, theme);
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
    "content",
    theme === "light" ? "#f4f7fb" : "#060811",
  );
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }));
}

export function useSiteTheme() {
  const [theme, setThemeState] = useState<SiteTheme>("dark");

  useEffect(() => {
    setThemeState(currentTheme());
    const sync = (event: Event) => {
      const selected = (event as CustomEvent<SiteTheme>).detail;
      setThemeState(selected === "light" ? "light" : currentTheme());
    };
    window.addEventListener(THEME_EVENT, sync);
    return () => window.removeEventListener(THEME_EVENT, sync);
  }, []);

  const setTheme = useCallback((nextTheme: SiteTheme) => {
    applySiteTheme(nextTheme);
    setThemeState(nextTheme);
  }, []);

  return [theme, setTheme] as const;
}
