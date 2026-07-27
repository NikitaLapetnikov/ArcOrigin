"use client";

import { Moon, Sun } from "lucide-react";
import { useSiteTheme } from "@/hooks/use-site-theme";

export function ThemeToggle() {
  const [theme, setTheme] = useSiteTheme();
  const light = theme === "light";
  return <button
    type="button"
    aria-label={light ? "Use dark theme" : "Use light theme"}
    title={light ? "Dark theme" : "Light theme"}
    onClick={() => setTheme(light ? "dark" : "light")}
    className="grid size-10 shrink-0 place-items-center rounded-[10px] border border-line bg-white/[.025] text-slate-300 transition hover:border-cyan/30 hover:bg-white/[.055] hover:text-white"
  >
    {light ? <Moon className="size-[17px]" /> : <Sun className="size-[17px]" />}
  </button>;
}
