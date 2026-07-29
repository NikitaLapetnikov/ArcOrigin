"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Download, Image as ImageIcon, X } from "lucide-react";
import { useAccount } from "wagmi";
import { arcChain } from "@/lib/chains";
import type { MarketSnapshot } from "@/lib/onchain/market-snapshot";
import type { TokenData } from "@/lib/types";
import { money, shortAddress, tickerLabel } from "@/lib/utils";
import { Button } from "./ui";

type PnlMetrics = {
  bought: number;
  sold: number;
  holdingTokens: number;
  holdingValue: number;
  pnl: number;
  pnlPercent: number;
};

function calculateMetrics(snapshot: MarketSnapshot, wallet?: string): PnlMetrics | null {
  const walletTrades = wallet
    ? snapshot.trades.filter((trade) => trade.wallet.toLowerCase() === wallet.toLowerCase())
    : [];
  if (!wallet || walletTrades.length === 0) return null;
  const bought = walletTrades.filter((trade) => trade.type === "Buy").reduce((sum, trade) => sum + trade.usdc, 0);
  const sold = walletTrades.filter((trade) => trade.type === "Sell").reduce((sum, trade) => sum + trade.usdc, 0);
  const holdingTokens = Math.max(0, walletTrades.reduce(
    (sum, trade) => sum + (trade.type === "Buy" ? trade.tokens : -trade.tokens),
    0,
  ));
  const holdingValue = holdingTokens * snapshot.price;
  const pnl = sold + holdingValue - bought;
  return {
    bought,
    sold,
    holdingTokens,
    holdingValue,
    pnl,
    pnlPercent: bought > 0 ? pnl / bought * 100 : 0,
  };
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
}

function loadTokenImage(source?: string): Promise<HTMLImageElement | null> {
  if (!source) return Promise.resolve(null);

  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (result: HTMLImageElement | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve(result);
    };
    const timeout = window.setTimeout(() => finish(null), 8_000);

    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    image.src = source;
  });
}

function drawTokenAvatar(
  context: CanvasRenderingContext2D,
  token: TokenData,
  image: HTMLImageElement | null,
  accent: string,
  accentRgb: string,
) {
  const x = 84;
  const y = 162;
  const size = 94;
  const radius = 24;

  if (image?.naturalWidth && image.naturalHeight) {
    const cropSize = Math.min(image.naturalWidth, image.naturalHeight);
    const sourceX = (image.naturalWidth - cropSize) / 2;
    const sourceY = (image.naturalHeight - cropSize) / 2;

    context.save();
    context.beginPath();
    context.roundRect(x, y, size, size, radius);
    context.clip();
    context.drawImage(image, sourceX, sourceY, cropSize, cropSize, x, y, size, size);
    context.restore();

    context.save();
    context.strokeStyle = `rgba(${accentRgb},.28)`;
    context.lineWidth = 2;
    context.beginPath();
    context.roundRect(x, y, size, size, radius);
    context.stroke();
    context.restore();
    return;
  }

  context.fillStyle = `rgba(${accentRgb},.14)`;
  roundedRect(context, x, y, size, size, radius);
  context.fillStyle = accent;
  context.font = "700 30px Inter, sans-serif";
  context.textAlign = "center";
  context.fillText(token.icon.slice(0, 3).toUpperCase(), x + size / 2, y + 58);
  context.textAlign = "left";
}

function drawShareCard(
  token: TokenData,
  metrics: PnlMetrics,
  wallet?: string,
  tokenImage: HTMLImageElement | null = null,
) {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 630;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");
  const positive = metrics.pnlPercent >= 0;
  const accent = positive ? "#73ecc7" : "#fb7185";
  const accentRgb = positive ? "115,236,199" : "251,113,133";

  const background = context.createLinearGradient(0, 0, 1200, 630);
  background.addColorStop(0, "#080d0e");
  background.addColorStop(0.55, "#0b1115");
  background.addColorStop(1, "#141125");
  context.fillStyle = background;
  context.fillRect(0, 0, 1200, 630);

  const glow = context.createRadialGradient(920, 150, 30, 920, 150, 460);
  glow.addColorStop(0, `rgba(${accentRgb},.2)`);
  glow.addColorStop(1, `rgba(${accentRgb},0)`);
  context.fillStyle = glow;
  context.fillRect(0, 0, 1200, 630);

  context.strokeStyle = "rgba(255,255,255,.055)";
  context.lineWidth = 1;
  for (let x = 0; x <= 1200; x += 60) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, 630);
    context.stroke();
  }
  for (let y = 0; y <= 630; y += 60) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(1200, y);
    context.stroke();
  }

  context.fillStyle = "rgba(8,13,14,.78)";
  roundedRect(context, 48, 42, 1104, 546, 28);
  context.strokeStyle = "rgba(255,255,255,.10)";
  context.strokeRect(49, 43, 1102, 544);

  context.fillStyle = "#73ecc7";
  context.font = "700 24px ui-monospace, monospace";
  context.fillText("ARCORIGIN", 84, 93);
  context.fillStyle = "#84919f";
  context.font = "500 17px ui-monospace, monospace";
  context.fillText(`${arcChain.name.toUpperCase()} · VERIFIED ONCHAIN`, 84, 123);

  drawTokenAvatar(context, token, tokenImage, accent, accentRgb);

  context.fillStyle = "#f7faf9";
  context.font = "700 35px Inter, sans-serif";
  context.fillText(token.name, 202, 199);
  context.fillStyle = "#84919f";
  context.font = "500 21px ui-monospace, monospace";
  context.fillText(`${tickerLabel(token.ticker)} · ${wallet ? shortAddress(wallet) : "WALLET UNAVAILABLE"}`, 202, 235);

  context.fillStyle = "#84919f";
  context.font = "600 16px ui-monospace, monospace";
  context.fillText("ESTIMATED ONCHAIN PNL", 84, 326);
  context.fillStyle = accent;
  context.font = "800 86px Inter, sans-serif";
  const percent = `${positive ? "+" : ""}${metrics.pnlPercent.toFixed(2)}%`;
  context.fillText(percent, 78, 413);
  context.fillStyle = "#dfe8e5";
  context.font = "600 24px Inter, sans-serif";
  context.fillText(`${metrics.pnl >= 0 ? "+" : "−"}${money(Math.abs(metrics.pnl))}`, 84, 458);

  const stats = [
    ["INVESTED", money(metrics.bought)],
    ["REALIZED", money(metrics.sold)],
    ["HOLDING VALUE", money(metrics.holdingValue)],
  ];
  stats.forEach(([label, value], index) => {
    const x = 650 + (index % 2) * 235;
    const y = 315 + Math.floor(index / 2) * 110;
    context.fillStyle = "#63717e";
    context.font = "600 14px ui-monospace, monospace";
    context.fillText(label, x, y);
    context.fillStyle = "#f4f8f7";
    context.font = "700 25px Inter, sans-serif";
    context.fillText(value, x, y + 36);
  });

  context.fillStyle = "#63717e";
  context.font = "500 15px Inter, sans-serif";
  context.fillText("Estimate from wallet curve trades · transfers may affect actual PnL", 84, 540);
  context.textAlign = "right";
  context.fillStyle = "#73ecc7";
  context.font = "600 18px ui-monospace, monospace";
  context.fillText("arcorigin.xyz", 1110, 540);
  return canvas;
}

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Image export failed.")), "image/png");
  });
}

export function PnlShareCard({ token, snapshot }: { token: TokenData; snapshot: MarketSnapshot }) {
  const { address } = useAccount();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const metrics = useMemo(() => calculateMetrics(snapshot, address), [address, snapshot]);
  const positive = (metrics?.pnlPercent ?? 0) >= 0;

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  async function exportImage(mode: "copy" | "download") {
    setNotice("");
    try {
      if (!metrics) throw new Error("No confirmed wallet trades are available for a PnL card.");
      const tokenImage = await loadTokenImage(token.image);
      const blob = await canvasBlob(drawShareCard(token, metrics, address, tokenImage));
      if (mode === "copy" && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          setNotice("Image copied");
          return;
        } catch {
          // Browsers can deny image clipboard access; downloading still gives the user the card.
        }
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${token.ticker.toLowerCase()}-pnl.png`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice(mode === "copy" ? "Clipboard unavailable — image downloaded" : "Image downloaded");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not export the image.");
    }
  }

  return <>
    <Button variant="ghost" className="h-8 px-2.5 text-xs" onClick={() => setOpen(true)}>
      <ImageIcon className="size-3.5" />PnL
    </Button>
    {open && <div
      role="dialog"
      aria-modal="true"
      aria-label="Share PnL"
      className="fixed inset-0 z-[80] grid place-items-center overflow-y-auto bg-[#020506]/80 p-3 backdrop-blur-md"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-line bg-[#0a1012] shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-white">Share performance</p>
            <p className="mt-0.5 text-[10px] text-slate-500">{metrics ? "Estimated from your confirmed curve trades" : address ? "No confirmed trades were found for this wallet" : "Connect a wallet for personal PnL"}</p>
          </div>
          <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="grid size-8 place-items-center rounded-lg text-slate-500 transition hover:bg-white/[.05] hover:text-white"><X className="size-4" /></button>
        </div>

        <div className="p-4 sm:p-5">
          {metrics ? <div className="relative aspect-[1200/630] overflow-hidden rounded-2xl border border-white/10 bg-[radial-gradient(circle_at_82%_18%,rgba(115,236,199,.15),transparent_34%),linear-gradient(135deg,#080d0e,#141125)] p-5 sm:p-7">
            <div className="absolute inset-0 opacity-20 [background-image:linear-gradient(rgba(255,255,255,.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.08)_1px,transparent_1px)] [background-size:32px_32px]" />
            <div className="relative flex h-full flex-col">
              <div className="flex items-start justify-between">
                <div><p className="font-mono text-[10px] font-bold tracking-[.2em] text-cyan sm:text-sm">ARCORIGIN</p><p className="mt-1 font-mono text-[7px] text-slate-500 sm:text-[9px]">{arcChain.name.toUpperCase()} · VERIFIED ONCHAIN</p></div>
                <p className="font-mono text-[8px] text-slate-500 sm:text-[10px]">{address ? shortAddress(address) : "SINCE LAUNCH"}</p>
              </div>
              <div className="mt-auto">
                <div className="flex items-center gap-3">
                  <div className="relative grid size-11 shrink-0 place-items-center overflow-hidden rounded-xl border border-white/10 bg-cyan/10 font-mono text-xs font-semibold text-cyan sm:size-14">
                    {token.image ? <span
                      aria-label={`${token.name} logo`}
                      className="absolute inset-0 bg-cover bg-center"
                      role="img"
                      style={{ backgroundImage: `url("${token.image}")` }}
                    /> : token.icon}
                  </div>
                  <div><p className="text-sm font-semibold text-white sm:text-xl">{token.name}</p><p className="font-mono text-[8px] text-slate-500 sm:text-[10px]">{tickerLabel(token.ticker)}</p></div>
                </div>
                <p className="mt-5 font-mono text-[7px] uppercase tracking-[.15em] text-slate-500 sm:text-[9px]">Estimated onchain PnL</p>
                <p className={`mt-1 text-4xl font-bold tracking-tight sm:text-6xl ${positive ? "text-emerald-300" : "text-rose-300"}`}>{positive ? "+" : ""}{metrics.pnlPercent.toFixed(2)}%</p>
                <div className="mt-4 grid grid-cols-3 gap-3 border-t border-white/10 pt-3">
                  {[
                    ["Invested", money(metrics.bought)],
                    ["Realized", money(metrics.sold)],
                    ["Holding value", money(metrics.holdingValue)],
                  ].map(([label, value]) => <div key={label}><p className="font-mono text-[6px] uppercase text-slate-600 sm:text-[8px]">{label}</p><p className="mt-1 truncate text-[9px] font-semibold text-white sm:text-sm">{value}</p></div>)}
                </div>
              </div>
            </div>
          </div> : <div className="rounded-2xl border border-line bg-black/20 p-8 text-center"><p className="text-sm font-medium text-white">{address ? "No confirmed trades for this wallet" : "Wallet not connected"}</p><p className="mx-auto mt-2 max-w-md text-xs leading-5 text-slate-500">{address ? "ArcOrigin will not invent a PnL value. A share card becomes available after an indexed buy or sell by this wallet." : "Connect the wallet that traded this token to calculate PnL from confirmed curve events."}</p></div>}
          <p className="mt-3 text-[10px] leading-4 text-slate-500">PnL is estimated from this wallet’s confirmed curve trades. Token transfers are not treated as buys or sells, so transferred balances can make the estimate incomplete.</p>
          {metrics && <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button onClick={() => void exportImage("copy")}><Copy className="size-4" />Copy image</Button>
            <Button variant="secondary" onClick={() => void exportImage("download")}><Download className="size-4" />Download PNG</Button>
            {notice && <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-300"><Check className="size-3.5" />{notice}</span>}
          </div>}
        </div>
      </div>
    </div>}
  </>;
}
