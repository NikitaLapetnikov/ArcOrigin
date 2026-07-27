"use client";

import { useCallback, useEffect, useState } from "react";

export type SiteTheme = "dark" | "light";

const THEME_EVENT = "arcorigin:theme";
const STORAGE_KEY = "arcorigin-theme";

function storedTheme(): SiteTheme | null {
  if (typeof window === "undefined") return null;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : null;
  } catch {
    return null;
  }
}

function currentTheme(): SiteTheme {
  if (typeof document === "undefined") return "dark";
  return storedTheme() ?? (document.documentElement.dataset.theme === "light" ? "light" : "dark");
}

function updateDocumentTheme(theme: SiteTheme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
    "content",
    theme === "light" ? "#f0f7fc" : "#060811",
  );
}

export function applySiteTheme(theme: SiteTheme) {
  updateDocumentTheme(theme);
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // The selected theme still applies for the current page when storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }));
}

export function useSiteTheme() {
  const [theme, setThemeState] = useState<SiteTheme>("dark");

  useEffect(() => {
    const restore = () => {
      const selected = currentTheme();
      updateDocumentTheme(selected);
      setThemeState(selected);
    };
    const syncThemeEvent = (event: Event) => {
      const selected = (event as CustomEvent<SiteTheme>).detail;
      setThemeState(selected === "light" || selected === "dark" ? selected : currentTheme());
    };
    const syncStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      restore();
    };
    const syncVisibility = () => {
      if (document.visibilityState === "visible") restore();
    };

    restore();
    window.addEventListener(THEME_EVENT, syncThemeEvent);
    window.addEventListener("storage", syncStorage);
    window.addEventListener("pageshow", restore);
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      window.removeEventListener(THEME_EVENT, syncThemeEvent);
      window.removeEventListener("storage", syncStorage);
      window.removeEventListener("pageshow", restore);
      document.removeEventListener("visibilitychange", syncVisibility);
    };
  }, []);

  const setTheme = useCallback((nextTheme: SiteTheme) => {
    applySiteTheme(nextTheme);
    setThemeState(nextTheme);
  }, []);

  return [theme, setTheme] as const;
}
