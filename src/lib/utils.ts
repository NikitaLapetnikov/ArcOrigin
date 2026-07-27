import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export function shortAddress(value: string, size = 4) { return `${value.slice(0, size + 2)}…${value.slice(-size)}`; }
export function tickerLabel(value: string) {
  const ticker = value.trim().replace(/^\$+/, "");
  return ticker ? `$${ticker}` : "$";
}
export function money(value: number, compact = false) {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (compact) {
    const [divisor, suffix] = absolute >= 1_000_000_000 ? [1_000_000_000, "B"] : absolute >= 1_000_000 ? [1_000_000, "M"] : absolute >= 1_000 ? [1_000, "K"] : [1, ""];
    return `${sign}$${trimZeros((absolute / divisor).toFixed(2))}${suffix}`;
  }
  if (absolute < 1) return `${sign}$${trimZeros(absolute.toFixed(6))}`;
  const [whole, decimals] = absolute.toFixed(2).split(".");
  return `${sign}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${decimals}`;
}
export function number(value: number) {
  const absolute = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  const [divisor, suffix] = absolute >= 1_000_000_000 ? [1_000_000_000, "B"] : absolute >= 1_000_000 ? [1_000_000, "M"] : absolute >= 1_000 ? [1_000, "K"] : [1, ""];
  return `${sign}${trimZeros((absolute / divisor).toFixed(suffix ? 1 : 0))}${suffix}`;
}
export function age(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1_440)}d`;
}

export function utcDateTime(timestamp?: number) {
  if (!timestamp) return "Time unavailable";
  return `${new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp * 1_000))} UTC`;
}

function trimZeros(value: string) { return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value; }
