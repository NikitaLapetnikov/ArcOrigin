"use client";

import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { isAddress } from "viem";

import { arcChain } from "@/lib/chains";

export const WATCHLIST_STORAGE_KEY = `arcorigin:${arcChain.id}:watchlist`;
const MAX_WATCHLIST_SIZE = 100;

export function readWatchlist() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(WATCHLIST_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string" && isAddress(item))
      .slice(0, MAX_WATCHLIST_SIZE)
      .map((item) => item.toLowerCase());
  } catch {
    return [];
  }
}

export function WatchlistButton({ address }: { address: string }) {
  const normalizedAddress = address.toLowerCase();
  const [watched, setWatched] = useState(false);

  useEffect(() => {
    const sync = () => setWatched(readWatchlist().includes(normalizedAddress));
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener("arcorigin:watchlist-updated", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("arcorigin:watchlist-updated", sync);
    };
  }, [normalizedAddress]);

  function toggle() {
    const current = readWatchlist();
    const next = current.includes(normalizedAddress)
      ? current.filter((item) => item !== normalizedAddress)
      : [normalizedAddress, ...current].slice(0, MAX_WATCHLIST_SIZE);
    try {
      window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(next));
      setWatched(next.includes(normalizedAddress));
      window.dispatchEvent(new Event("arcorigin:watchlist-updated"));
    } catch {
      // The control remains safe if storage is unavailable in private browsing.
    }
  }

  return <button
    type="button"
    aria-pressed={watched}
    aria-label={watched ? "Remove token from watchlist" : "Add token to watchlist"}
    title={watched ? "Remove from watchlist" : "Add to watchlist"}
    onClick={toggle}
    className={`grid size-8 place-items-center rounded-lg border transition ${
      watched
        ? "border-amber-300/30 bg-amber-300/10 text-amber-200"
        : "border-line text-slate-500 hover:border-amber-300/25 hover:text-amber-200"
    }`}
  >
    <Star className={`size-4 ${watched ? "fill-current" : ""}`} />
  </button>;
}
