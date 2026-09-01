"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Copy, ExternalLink, ImagePlus, LogOut, Pencil, RefreshCw, Share2, Trash2, UserRound, X } from "lucide-react";
import { formatUnits, type Address } from "viem";
import {
  useAccount,
  useDisconnect,
  useReadContracts,
  useWalletClient,
} from "wagmi";
import { useFactoryTokenIndex } from "@/hooks/use-factory-token-index";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import { TokenLabels } from "@/components/token-labels";
import { arcChain, EXPLORER_URL } from "@/lib/chains";
import { erc20Abi } from "@/lib/contracts";
import type { TokenData, Trade } from "@/lib/types";
import { money, number, shortAddress, tickerLabel, utcDateTime } from "@/lib/utils";
import { Badge, Button, LinkButton, TokenIcon, WarningBox } from "@/components/ui";

type ProfileTab = "Positions" | "History" | "Activity" | "Launches";
type PortfolioRange = "1D" | "7D" | "30D";
type WalletTrade = { token: TokenData; trade: Trade };
type WalletProfile = { address: Address; username: string; avatar: string; updatedAt: string };
type PortfolioPoint = { timestamp: number; value: number };
type Position = {
  token: TokenData;
  balance: number;
  value: number;
  bought: number;
  sold: number;
  pnl: number | null;
};
type IndexedWalletBalance = { tokenAddress: string; balance: string };

const tabs: ProfileTab[] = ["Positions", "History", "Activity", "Launches"];
const portfolioRanges: Record<PortfolioRange, number> = { "1D": 86_400, "7D": 604_800, "30D": 2_592_000 };
const PROFILE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const PROFILE_IMAGE_MAX_BYTES = 350_000;

async function digestHex(value: ArrayBuffer | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `0x${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("The avatar could not be optimized.")),
    "image/webp",
    quality,
  ));
}

async function optimizeProfileImage(file: File) {
  if (!PROFILE_IMAGE_TYPES.includes(file.type)) throw new Error("Choose a PNG, JPG, or WebP image.");
  if (file.size > 8_000_000) throw new Error("The original image must be 8 MB or smaller.");
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 20_000_000) throw new Error("Image dimensions are too large.");
    const edge = Math.min(bitmap.width, bitmap.height);
    const sourceX = Math.floor((bitmap.width - edge) / 2);
    const sourceY = Math.floor((bitmap.height - edge) / 2);
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Your browser could not process this image.");
    context.drawImage(bitmap, sourceX, sourceY, edge, edge, 0, 0, 512, 512);
    let blob = await canvasBlob(canvas, 0.82);
    if (blob.size > PROFILE_IMAGE_MAX_BYTES) blob = await canvasBlob(canvas, 0.62);
    if (blob.size > PROFILE_IMAGE_MAX_BYTES) throw new Error("The optimized avatar is still too large.");
    return new File([blob], "profile-avatar.webp", { type: "image/webp" });
  } finally {
    bitmap.close();
  }
}

export function ProfileDashboard({ profileAddress }: { profileAddress?: Address } = {}) {
  const { address: connectedAddress } = useAccount();
  const address = profileAddress ?? connectedAddress;
  const ownsProfile = Boolean(
    address && connectedAddress && address.toLowerCase() === connectedAddress.toLowerCase(),
  );
  const { disconnect } = useDisconnect();
  const { data: walletClient } = useWalletClient();
  const { tokens, loading, error, refresh, isPartial } = useFactoryTokenIndex();
  const [activeTab, setActiveTab] = useState<ProfileTab>("Positions");
  const [portfolioRange, setPortfolioRange] = useState<PortfolioRange>("1D");
  const [actionMessage, setActionMessage] = useState("");
  const [profile, setProfile] = useState<WalletProfile | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editUsername, setEditUsername] = useState("");
  const [editImage, setEditImage] = useState<File | null>(null);
  const [editPreview, setEditPreview] = useState("");
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [editError, setEditError] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [indexedBalances, setIndexedBalances] = useState<Map<string, bigint> | null>(null);
  const launches = useMemo(() => {
    if (!address) return [];
    return tokens.filter((token) => token.creator.toLowerCase() === address.toLowerCase())
      .sort((left, right) => (right.launchedAt ?? 0) - (left.launchedAt ?? 0));
  }, [address, tokens]);
  const balanceReads = useReadContracts({
    contracts: tokens.map((token) => ({
      address: token.address as Address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address ?? "0x0000000000000000000000000000000000000000"],
      chainId: arcChain.id,
    })),
    query: {
      enabled: Boolean(address) && tokens.length > 0 && indexedBalances === null,
      staleTime: 10_000,
      refetchInterval: 30_000,
    },
    allowFailure: true,
  });

  const refreshIndexedBalances = useCallback(async () => {
    if (!address) return;
    try {
      const response = await fetch(`/api/onchain/wallets/${address}/balances`, {
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });
      const payload = await response.json() as { balances?: IndexedWalletBalance[] };
      if (!response.ok || !Array.isArray(payload.balances)) return;
      const next = new Map<string, bigint>();
      for (const item of payload.balances) {
        if (!item
          || typeof item.tokenAddress !== "string"
          || !/^0x[0-9a-fA-F]{40}$/.test(item.tokenAddress)
          || typeof item.balance !== "string"
          || !/^\d+$/.test(item.balance)) return;
        next.set(item.tokenAddress.toLowerCase(), BigInt(item.balance));
      }
      setIndexedBalances(next);
    } catch {
      // Keep the last indexed balances and let direct contract reads remain the fallback.
    }
  }, [address]);

  useLiveRefresh({
    enabled: Boolean(address),
    intervalMs: 15_000,
    refresh: refreshIndexedBalances,
  });

  useEffect(() => {
    setIndexedBalances(null);
    if (!address) return;
    void refreshIndexedBalances();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const handleHolderChange = (event: Event) => {
      const detail = (event as CustomEvent<{ from?: unknown; to?: unknown }>).detail;
      const normalized = address.toLowerCase();
      if (typeof detail?.from === "string" && detail.from.toLowerCase() === normalized) {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => void refreshIndexedBalances(), 400);
      } else if (typeof detail?.to === "string" && detail.to.toLowerCase() === normalized) {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => void refreshIndexedBalances(), 400);
      }
    };
    window.addEventListener("arcorigin:holder-event", handleHolderChange);
    return () => {
      window.removeEventListener("arcorigin:holder-event", handleHolderChange);
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [address, refreshIndexedBalances]);

  useEffect(() => {
    if (!address) {
      setProfile(null);
      return;
    }
    let active = true;
    void fetch(`/api/profile/${address}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { profile?: WalletProfile | null };
        if (active && response.ok) setProfile(payload.profile ?? null);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [address]);

  useEffect(() => () => {
    if (editPreview.startsWith("blob:")) URL.revokeObjectURL(editPreview);
  }, [editPreview]);

  const walletTrades = useMemo(() => {
    if (!address) return [];
    const normalized = address.toLowerCase();
    return tokens.flatMap((token) => token.recentTrades
      .filter((trade) => trade.wallet.toLowerCase() === normalized)
      .map((trade): WalletTrade => ({ token, trade })))
      .sort((left, right) => (right.trade.timestamp ?? 0) - (left.trade.timestamp ?? 0));
  }, [address, tokens]);

  const positions = useMemo(() => tokens.map((token, index): Position | null => {
    const indexedBalance = indexedBalances?.get(token.address.toLowerCase());
    const contractBalance = balanceReads.data?.[index]?.result;
    const rawBalance = indexedBalances === null
      ? contractBalance
      : indexedBalance ?? 0n;
    if (typeof rawBalance !== "bigint" || rawBalance <= 0n) return null;
    const balance = Number(formatUnits(rawBalance, 18));
    const trades = walletTrades.filter((item) => item.token.address.toLowerCase() === token.address.toLowerCase());
    const bought = trades.filter(({ trade }) => trade.type === "Buy").reduce((sum, { trade }) => sum + trade.usdc, 0);
    const sold = trades.filter(({ trade }) => trade.type === "Sell").reduce((sum, { trade }) => sum + trade.usdc, 0);
    const tradedBalance = trades.reduce((sum, { trade }) => sum + (trade.type === "Buy" ? trade.tokens : -trade.tokens), 0);
    const reconciled = Math.abs(balance - Math.max(0, tradedBalance)) <= Math.max(0.000001, balance * 1e-9);
    const price = Number.isFinite(token.price) && token.price > 0 ? token.price : 0;
    const value = balance * price;
    return { token, balance, value, bought, sold, pnl: reconciled && bought > 0 ? sold + value - bought : null };
  })
    .filter((position): position is Position => Boolean(position))
    .sort((left, right) => right.value - left.value || left.token.name.localeCompare(right.token.name)),
  [balanceReads.data, indexedBalances, tokens, walletTrades]);

  const balancesPending = indexedBalances === null && balanceReads.isPending;
  const portfolioValue = positions.reduce((sum, position) => sum + position.value, 0);
  const confirmedVolume = walletTrades.reduce((sum, { trade }) => sum + trade.usdc, 0);
  const portfolioHistory = useMemo(() => {
    const end = Math.floor(Date.now() / 60_000) * 60;
    const start = end - portfolioRanges[portfolioRange];
    const sampleCount = 49;
    const tokenHistories = tokens.flatMap((token, index) => {
      const indexedBalance = indexedBalances?.get(token.address.toLowerCase());
      const contractBalance = balanceReads.data?.[index]?.result;
      const rawBalance = indexedBalances === null
        ? contractBalance
        : indexedBalance ?? 0n;
      if (typeof rawBalance !== "bigint") return [];
      const actualBalance = Number(formatUnits(rawBalance, 18));
      const trades = walletTrades
        .filter((item) => item.token.address.toLowerCase() === token.address.toLowerCase() && item.trade.timestamp)
        .map(({ trade }) => trade)
        .sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));
      const allWalletTrades = walletTrades.filter((item) => item.token.address.toLowerCase() === token.address.toLowerCase());
      if (trades.length !== allWalletTrades.length) return [];
      const derivedBalance = trades.reduce((sum, trade) => sum + (trade.type === "Buy" ? trade.tokens : -trade.tokens), 0);
      const reconciled = Math.abs(actualBalance - Math.max(0, derivedBalance)) <= Math.max(0.000001, actualBalance * 1e-9);
      const prices = token.chartData
        .filter((point) => point.timestamp && Number.isFinite(point.price) && point.price > 0)
        .sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));
      if (!reconciled || prices.length === 0) return [];
      return [{ token, trades, prices }];
    });
    if (tokenHistories.length === 0) return [] as PortfolioPoint[];
    return Array.from({ length: sampleCount }, (_, index): PortfolioPoint => {
      const timestamp = Math.round(start + (index / (sampleCount - 1)) * (end - start));
      const value = tokenHistories.reduce((portfolioTotal, history) => {
        const tokenBalance = history.trades.reduce((sum, trade) => (
          (trade.timestamp ?? 0) <= timestamp ? sum + (trade.type === "Buy" ? trade.tokens : -trade.tokens) : sum
        ), 0);
        if (tokenBalance <= 0) return portfolioTotal;
        const historicalPrice = [...history.prices].reverse().find((point) => (point.timestamp ?? 0) <= timestamp)?.price;
        const price = index === sampleCount - 1 ? history.token.price : historicalPrice;
        return price ? portfolioTotal + tokenBalance * price : portfolioTotal;
      }, 0);
      return { timestamp, value };
    });
  }, [balanceReads.data, indexedBalances, portfolioRange, tokens, walletTrades]);

  async function copyAddress() {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    setActionMessage("Address copied");
  }

  async function shareProfile() {
    if (!address) return;
    const url = `${window.location.origin}/profile/${address}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "ArcOrigin profile", text: address, url });
        return;
      } catch {
        return;
      }
    }
    await navigator.clipboard.writeText(url);
    setActionMessage("Profile link copied");
  }


  function openProfileEditor() {
    setEditUsername(profile?.username ?? "");
    setEditImage(null);
    setEditPreview(profile?.avatar ?? "");
    setRemoveAvatar(false);
    setEditError("");
    setEditOpen(true);
  }

  async function chooseAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setEditError("");
    try {
      const optimized = await optimizeProfileImage(file);
      setEditImage(optimized);
      setEditPreview(URL.createObjectURL(optimized));
      setRemoveAvatar(false);
    } catch (selectionError) {
      setEditError(selectionError instanceof Error ? selectionError.message : "The avatar could not be processed.");
    }
  }

  async function saveProfile() {
    if (!address || !connectedAddress || !ownsProfile || !walletClient) {
      setEditError("Connect your wallet before saving the profile.");
      return;
    }
    const username = editUsername.trim().toLowerCase();
    if (username && !/^[a-z0-9_]{3,20}$/.test(username)) {
      setEditError("Username must contain 3–20 lowercase letters, numbers, or underscores.");
      return;
    }
    setSavingProfile(true);
    setEditError("");
    try {
      const imageHash = editImage ? await digestHex(await editImage.arrayBuffer()) : "";
      const commitment = await digestHex(JSON.stringify({ username, imageHash, removeAvatar }));
      const challengeResponse = await fetch("/api/profile/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, commitment }),
      });
      const challenge = await challengeResponse.json() as { nonce?: string; message?: string; error?: string };
      if (!challengeResponse.ok || !challenge.nonce || !challenge.message) throw new Error(challenge.error ?? "Profile authorization failed.");
      const signature = await walletClient.signMessage({ account: connectedAddress, message: challenge.message });
      const body = new FormData();
      body.append("nonce", challenge.nonce);
      body.append("address", connectedAddress);
      body.append("signature", signature);
      body.append("username", username);
      body.append("imageHash", imageHash);
      body.append("removeAvatar", String(removeAvatar));
      if (editImage) body.append("image", editImage);
      const response = await fetch("/api/profile", { method: "POST", body });
      const result = await response.json() as { profile?: WalletProfile; error?: string };
      if (!response.ok || !result.profile) throw new Error(result.error ?? "Profile could not be saved.");
      setProfile(result.profile);
      setEditOpen(false);
      setActionMessage("Profile updated");
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "Profile could not be saved.";
      setEditError(/rejected|denied/i.test(message) ? "The signature request was cancelled." : message);
    } finally {
      setSavingProfile(false);
    }
  }

  if (!address) return <div className="container-shell py-14">
    <div className="mx-auto max-w-xl rounded-2xl border border-line bg-panel p-8 text-center shadow-glow">
      <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-line bg-white/[.03] text-slate-300"><UserRound className="size-6" /></div>
      <h1 className="mt-5 text-2xl font-semibold tracking-[-.035em] text-white">Connect your wallet</h1>
      <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-slate-400">Connect from the header to view confirmed positions, trades, activity, and launches associated with your wallet.</p>
      <LinkButton href="/tokens" variant="secondary" className="mt-6">Explore tokens</LinkButton>
    </div>
  </div>;

  return <div className="container-shell py-8 md:py-12">
    <section className="overflow-hidden rounded-[22px] border border-line bg-panel shadow-glow">
      <div className="grid gap-5 border-b border-line p-5 sm:p-7 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
        <div className="flex min-w-0 items-center gap-4">
          <ProfileAvatar avatar={profile?.avatar} size="large" />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-[-.035em] text-white sm:text-[22px]" title={profile?.username ? `@${profile.username}` : address}>{profile?.username ? `@${profile.username}` : address}</h1>
            <p className="mt-1 truncate text-sm font-medium text-slate-400" title={profile?.username ? address : undefined}>{profile?.username ? address : ownsProfile ? "Your ArcOrigin profile" : "Public ArcOrigin profile"}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center xl:flex-nowrap xl:justify-end">
          {ownsProfile && <Button className="h-9 whitespace-nowrap px-3 text-xs" variant="secondary" onClick={openProfileEditor}><Pencil className="size-3.5" />Edit profile</Button>}
          <Button className="h-9 whitespace-nowrap px-3 text-xs" variant="secondary" onClick={() => void copyAddress()}><Copy className="size-3.5" />Copy address</Button>
          <Button className="h-9 whitespace-nowrap px-3 text-xs" variant="secondary" onClick={() => void shareProfile()}><Share2 className="size-3.5" />Share</Button>
          <a href={`${EXPLORER_URL}/address/${address}`} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-[10px] border border-line bg-white/[.035] px-3 text-xs font-semibold text-slate-100 transition hover:bg-white/[.06]">Arcscan <ExternalLink className="size-3.5" /></a>
          {ownsProfile && <Button className="h-9 whitespace-nowrap px-3 text-xs max-sm:col-span-2" variant="danger" onClick={() => disconnect()}><LogOut className="size-3.5" />Disconnect</Button>}
        </div>
      </div>
      <div className="p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <p className="text-[15px] font-medium text-slate-300">Portfolio value</p>
            <p className="mt-2 text-[42px] font-semibold leading-none tracking-[-.055em] text-white sm:text-[52px]">{balancesPending ? "—" : money(portfolioValue)}</p>
            <p className="mt-3 text-[14px] font-medium text-slate-400">{positions.length} open position{positions.length === 1 ? "" : "s"} · {money(confirmedVolume)} total trade volume</p>
          </div>
          <div className="flex items-center gap-2">
            {isPartial && <Badge tone="warn">Partial market data</Badge>}
            <Button variant="secondary" disabled={loading} onClick={() => {
              void refresh(true);
              void refreshIndexedBalances();
              void balanceReads.refetch();
            }}><RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button>
          </div>
        </div>
        <PortfolioChart
          points={portfolioHistory}
          range={portfolioRange}
          currentValue={portfolioValue}
          onRange={setPortfolioRange}
        />
      </div>
    </section>

    <section className="mt-5 overflow-hidden rounded-[22px] border border-line bg-panel shadow-glow">
      <div className="flex gap-1 overflow-x-auto border-b border-line px-4 pt-3 sm:px-6" role="tablist" aria-label="Profile data">
        {tabs.map((tab) => <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} onClick={() => setActiveTab(tab)} className={activeTab === tab ? "border-b-2 border-cyan px-4 py-3 text-sm font-semibold text-white" : "border-b-2 border-transparent px-4 py-3 text-sm font-semibold text-slate-400 transition hover:text-white"}>
          {tab}{tab === "Positions" && positions.length > 0 ? ` (${positions.length})` : tab === "History" && walletTrades.length > 0 ? ` (${walletTrades.length})` : tab === "Launches" && launches.length > 0 ? ` (${launches.length})` : ""}
        </button>)}
      </div>
      {activeTab === "Positions" && <PositionsTable positions={positions} loading={balancesPending} />}
      {activeTab === "History" && <HistoryTable trades={walletTrades} />}
      {activeTab === "Activity" && <ActivityFeed trades={walletTrades} launches={launches} />}
      {activeTab === "Launches" && <LaunchGrid tokens={launches} />}
      {error && <div className="px-5 pb-5"><WarningBox>{error}</WarningBox></div>}
      {actionMessage && <p className="border-t border-line px-6 py-3 text-xs text-emerald-300">{actionMessage}</p>}
    </section>
    {editOpen && ownsProfile && <ProfileEditor
      username={editUsername}
      preview={editPreview}
      hasSavedAvatar={Boolean(profile?.avatar)}
      saving={savingProfile}
      error={editError}
      onUsername={setEditUsername}
      onChoose={chooseAvatar}
      onRemove={() => {
        setEditImage(null);
        setEditPreview("");
        setRemoveAvatar(true);
      }}
      onClose={() => !savingProfile && setEditOpen(false)}
      onSave={() => void saveProfile()}
    />}
  </div>;
}

function PortfolioChart({
  points,
  range,
  currentValue,
  onRange,
}: {
  points: PortfolioPoint[];
  range: PortfolioRange;
  currentValue: number;
  onRange: (range: PortfolioRange) => void;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const width = 1_000;
  const height = 250;
  const plot = { left: 18, right: 82, top: 22, bottom: 36 };
  const values = points.map((point) => point.value);
  const rawMin = values.length > 0 ? Math.min(...values) : 0;
  const rawMax = values.length > 0 ? Math.max(...values) : Math.max(1, currentValue);
  const padding = rawMax === rawMin ? Math.max(rawMax * 0.08, 0.25) : (rawMax - rawMin) * 0.12;
  const minimum = Math.max(0, rawMin - padding);
  const maximum = rawMax + padding;
  const valueRange = Math.max(maximum - minimum, 0.000001);
  const xFor = (index: number) => plot.left + (index / Math.max(1, points.length - 1)) * (width - plot.left - plot.right);
  const yFor = (value: number) => plot.top + (1 - (value - minimum) / valueRange) * (height - plot.top - plot.bottom);
  const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"} ${xFor(index).toFixed(2)} ${yFor(point.value).toFixed(2)}`).join(" ");
  const areaPath = points.length > 1
    ? `${linePath} L ${xFor(points.length - 1).toFixed(2)} ${height - plot.bottom} L ${xFor(0).toFixed(2)} ${height - plot.bottom} Z`
    : "";
  const first = points[0];
  const last = points.at(-1);
  const change = first && last ? last.value - first.value : 0;
  const changePercent = first && first.value > 0 ? change / first.value * 100 : null;
  const yTicks = [maximum, (maximum + minimum) / 2, minimum];
  const xTicks = points.length > 1 ? [points[0], points[Math.floor((points.length - 1) / 2)], points[points.length - 1]] : [];
  const activePoint = activeIndex === null ? null : points[activeIndex];
  const activeX = activePoint ? xFor(activeIndex ?? 0) : 0;
  const activeY = activePoint ? yFor(activePoint.value) : 0;
  const activeXPercent = activeX / width * 100;
  const activeYPercent = activeY / height * 100;
  const tooltipXPercent = Math.max(12, Math.min(88, activeXPercent));

  useEffect(() => {
    setActiveIndex(null);
  }, [points, range]);

  function selectNearestPoint(clientX: number, element: HTMLDivElement) {
    if (points.length < 2) return;
    const bounds = element.getBoundingClientRect();
    const plotLeft = bounds.width * plot.left / width;
    const plotRight = bounds.width * plot.right / width;
    const usableWidth = Math.max(1, bounds.width - plotLeft - plotRight);
    const progress = Math.max(0, Math.min(1, (clientX - bounds.left - plotLeft) / usableWidth));
    setActiveIndex(Math.round(progress * (points.length - 1)));
  }

  function moveCursor(event: ReactPointerEvent<HTMLDivElement>) {
    selectNearestPoint(event.clientX, event.currentTarget);
  }

  function moveCursorWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (points.length < 2 || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    setActiveIndex((current) => {
      const startingIndex = current ?? points.length - 1;
      return Math.max(0, Math.min(points.length - 1, startingIndex + (event.key === "ArrowLeft" ? -1 : 1)));
    });
  }

  return <div className="mt-7 overflow-hidden rounded-2xl border border-line bg-black/15">
    <div className="flex flex-col gap-4 border-b border-line/80 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div>
        <div className="flex items-center gap-2.5">
          <p className="text-sm font-semibold text-white">Portfolio balance</p>
          {points.length > 1 && <span className={change >= 0 ? "text-xs font-semibold text-emerald-300" : "text-xs font-semibold text-rose-300"}>
            {change >= 0 ? "+" : ""}{money(change)}
            {changePercent !== null ? ` (${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%)` : ""}
          </span>}
        </div>
        <p className="mt-1 text-xs font-medium text-slate-500">Confirmed value · {range}</p>
      </div>
      <div className="inline-flex w-fit items-center rounded-xl border border-line bg-white/[.025] p-1" role="group" aria-label="Portfolio chart range">
        {(Object.keys(portfolioRanges) as PortfolioRange[]).map((option) => <button
          key={option}
          type="button"
          aria-pressed={range === option}
          onClick={() => onRange(option)}
          className={range === option
            ? "h-8 min-w-12 rounded-lg bg-white/[.09] px-3 text-xs font-semibold text-white shadow-sm"
            : "h-8 min-w-12 rounded-lg px-3 text-xs font-semibold text-slate-400 transition hover:text-white"}
        >{option}</button>)}
      </div>
    </div>
    <div
      className="relative h-[260px] w-full cursor-crosshair touch-pan-y select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan/40 sm:h-[300px]"
      tabIndex={points.length > 1 ? 0 : -1}
      aria-label={`${range} portfolio chart. Move the pointer or use the left and right arrow keys to inspect balance over time.`}
      onPointerDown={moveCursor}
      onPointerMove={moveCursor}
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch") setActiveIndex(null);
      }}
      onKeyDown={moveCursorWithKeyboard}
    >
      {points.length > 1 ? <svg className="absolute inset-0 size-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${range} portfolio value line chart`}>
        <defs>
          <linearGradient id="portfolio-area-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {yTicks.map((tick, index) => {
          const y = yFor(tick);
          return <g key={`${tick}-${index}`}>
            <line x1={plot.left} x2={width - plot.right} y1={y} y2={y} stroke="rgb(var(--line-rgb))" strokeWidth="1" strokeDasharray="4 6" vectorEffect="non-scaling-stroke" />
            <text x={width - 10} y={y + 4} fill="var(--text-tertiary)" fontSize="11" textAnchor="end">{money(tick, true)}</text>
          </g>;
        })}
        {xTicks.map((tick, index) => <text key={tick.timestamp} x={xFor(index * Math.floor((points.length - 1) / 2))} y={height - 10} fill="var(--text-tertiary)" fontSize="11" textAnchor={index === 0 ? "start" : index === 2 ? "end" : "middle"}>
          {formatPortfolioTime(tick.timestamp, range)}
        </text>)}
        <path d={areaPath} fill="url(#portfolio-area-gradient)" />
        <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {activePoint && <g aria-hidden="true">
          <line
            x1={activeX}
            x2={activeX}
            y1={plot.top}
            y2={height - plot.bottom}
            stroke="var(--chart-crosshair)"
            strokeWidth="1"
            strokeDasharray="2 5"
            strokeOpacity=".78"
            vectorEffect="non-scaling-stroke"
          />
          <line
            x1={plot.left}
            x2={width - plot.right}
            y1={activeY}
            y2={activeY}
            stroke="var(--chart-crosshair)"
            strokeWidth="1"
            strokeDasharray="2 6"
            strokeOpacity=".44"
            vectorEffect="non-scaling-stroke"
          />
          <circle cx={activeX} cy={activeY} r="5.5" fill="var(--accent)" stroke="var(--surface-1)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        </g>}
        {last && <circle cx={xFor(points.length - 1)} cy={yFor(last.value)} r="4.5" fill="var(--accent)" stroke="var(--surface-1)" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
      </svg> : <div className="absolute inset-0 grid place-items-center px-6 text-center">
        <div>
          <p className="text-sm font-semibold text-slate-300">No confirmed history for this period</p>
          <p className="mt-2 text-xs font-medium text-slate-500">The chart uses confirmed wallet trades and indexed onchain prices only.</p>
        </div>
      </div>}
      {activePoint && <div
        className="portfolio-chart-tooltip pointer-events-none absolute z-10 min-w-[132px] rounded-xl border px-3 py-2.5 backdrop-blur-xl"
        style={{
          left: `${tooltipXPercent}%`,
          top: `${Math.max(12, Math.min(88, activeYPercent))}%`,
          transform: activeYPercent < 38 ? "translate(-50%, 14px)" : "translate(-50%, calc(-100% - 14px))",
        }}
        role="status"
        aria-live="polite"
      >
        <p className="text-sm font-semibold tracking-[-.02em]">{money(activePoint.value)}</p>
        <p className="portfolio-chart-tooltip-time mt-1 whitespace-nowrap text-[11px] font-medium">{formatPortfolioTooltipTime(activePoint.timestamp)}</p>
      </div>}
    </div>
  </div>;
}

function formatPortfolioTime(timestamp: number, range: PortfolioRange) {
  return new Intl.DateTimeFormat("en-GB", range === "1D"
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { day: "2-digit", month: "short" }).format(new Date(timestamp * 1_000));
}

function formatPortfolioTooltipTime(timestamp: number) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp * 1_000));
}

function PositionsTable({ positions, loading }: { positions: Position[]; loading: boolean }) {
  if (loading) return <EmptyPanel title="Reading token balances…" body="Balances are being read directly from each token contract." />;
  if (positions.length === 0) return <EmptyPanel title="No open positions" body="No positive balance was found in the currently indexed ArcOrigin tokens." action />;
  return <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm">
    <thead><tr className="border-b border-line text-[10px] font-semibold uppercase tracking-[.08em] text-slate-400"><th className="px-6 py-3">Token</th><th>Balance</th><th>Value</th><th>Bought</th><th>Sold</th><th>PnL</th><th className="pr-6 text-right">Action</th></tr></thead>
    <tbody>{positions.map((position) => <tr key={position.token.address} className="border-b border-line/70 last:border-0 hover:bg-white/[.02]">
      <td className="px-6 py-4"><TokenLabel token={position.token} /></td>
      <td className="text-slate-300">{number(position.balance)}</td><td className="font-medium text-white">{money(position.value)}</td><td className="text-emerald-300">{money(position.bought)}</td><td className="text-rose-300">{money(position.sold)}</td>
      <td className={position.pnl === null ? "text-slate-400" : position.pnl >= 0 ? "text-emerald-300" : "text-rose-300"}>{position.pnl === null ? "—" : `${position.pnl >= 0 ? "+" : ""}${money(position.pnl)}`}</td>
      <td className="pr-6 text-right"><Link href={`/tokens/${position.token.address}`} className="font-semibold text-cyan hover:underline">Trade</Link></td>
    </tr>)}</tbody>
  </table><p className="border-t border-line px-6 py-3 text-xs font-medium leading-5 text-slate-400">PnL appears only when the actual ERC-20 balance matches confirmed pool trades. Transfers can make cost basis unavailable.</p></div>;
}

function HistoryTable({ trades }: { trades: WalletTrade[] }) {
  if (trades.length === 0) return <EmptyPanel title="No confirmed trades" body={`Wallet buys and sells will appear here after their ${arcChain.name} transaction is confirmed.`} action />;
  return <div className="overflow-x-auto"><table className="w-full min-w-[850px] text-left text-sm">
    <thead><tr className="border-b border-line text-[10px] font-semibold uppercase tracking-[.08em] text-slate-400"><th className="px-6 py-3">Time</th><th>Token</th><th>Type</th><th>USDC</th><th>Tokens</th><th className="pr-6 text-right">Transaction</th></tr></thead>
    <tbody>{trades.map(({ token, trade }) => <tr key={`${token.address}-${trade.txHash}`} className="border-b border-line/70 last:border-0 hover:bg-white/[.02]">
      <td className="px-6 py-4 text-xs font-medium text-slate-400">{utcDateTime(trade.timestamp)}</td><td><TokenLabel token={token} compact /></td><td className={trade.type === "Buy" ? "text-emerald-300" : "text-rose-300"}>{trade.type}</td><td className="text-white">{money(trade.usdc)}</td><td className="text-slate-300">{number(trade.tokens)}</td>
      <td className="pr-6 text-right"><a href={`${EXPLORER_URL}/tx/${trade.txHash}`} target="_blank" rel="noreferrer" className="text-cyan hover:underline">{shortAddress(trade.txHash)}</a></td>
    </tr>)}</tbody>
  </table></div>;
}

function ActivityFeed({ trades, launches }: { trades: WalletTrade[]; launches: TokenData[] }) {
  const items = [
    ...trades.map(({ token, trade }) => ({ key: trade.txHash, timestamp: trade.timestamp ?? 0, title: `${trade.type === "Buy" ? "Bought" : "Sold"} ${tickerLabel(token.ticker)}`, detail: `${money(trade.usdc)} · ${number(trade.tokens)} tokens`, href: `${EXPLORER_URL}/tx/${trade.txHash}`, token })),
    ...launches.map((token) => ({ key: token.launchTxHash ?? token.address, timestamp: token.launchedAt ?? 0, title: `Launched ${tickerLabel(token.ticker)}`, detail: token.name, href: `/tokens/${token.address}`, token })),
  ].sort((left, right) => right.timestamp - left.timestamp);
  if (items.length === 0) return <EmptyPanel title="No wallet activity" body="Confirmed trades and token launches from this wallet will appear here." action />;
  return <div className="divide-y divide-line/70">{items.map((item) => <a key={`${item.key}-${item.title}`} href={item.href} target={item.href.startsWith("http") ? "_blank" : undefined} rel={item.href.startsWith("http") ? "noreferrer" : undefined} className="flex items-center gap-4 px-6 py-4 transition hover:bg-white/[.02]">
    <TokenIcon label={item.token.icon} image={item.token.image} className="size-10 rounded-xl" />
    <div className="min-w-0 flex-1"><p className="font-semibold text-white">{item.title}</p><p className="mt-1 truncate text-xs text-slate-500">{item.detail}</p></div>
    <p className="shrink-0 text-xs text-slate-500">{utcDateTime(item.timestamp)}</p><ExternalLink className="size-4 shrink-0 text-slate-600" />
  </a>)}</div>;
}

function LaunchGrid({ tokens }: { tokens: TokenData[] }) {
  if (tokens.length === 0) return <EmptyPanel title="No launches from this wallet" body="Tokens created from this address will appear here after the factory transaction is confirmed." />;
  return <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">{tokens.map((token) => <Link key={token.address} href={`/tokens/${token.address}`} className="rounded-2xl border border-line bg-black/15 p-4 transition hover:border-cyan/25 hover:bg-white/[.025]">
    <div className="flex items-center gap-3"><TokenIcon label={token.icon} image={token.image} className="size-12 rounded-xl" /><div className="min-w-0"><p className="truncate font-semibold text-white">{token.name}</p><p className="mt-1 font-mono text-xs text-slate-500">{tickerLabel(token.ticker)}</p><div className="mt-1.5"><TokenLabels token={token} compact /></div></div></div>
    <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-xs"><span className="text-slate-500">{utcDateTime(token.launchedAt)}</span><span className="text-slate-300">{money(token.marketCap, true)} MC</span></div>
  </Link>)}</div>;
}

function TokenLabel({ token, compact = false }: { token: TokenData; compact?: boolean }) {
  return <div className="flex items-center gap-3"><TokenIcon label={token.icon} image={token.image} className={compact ? "size-8 rounded-lg" : "size-10 rounded-xl"} /><div className="min-w-0"><p className="truncate font-semibold text-white">{token.name}</p><p className="mt-0.5 font-mono text-[10px] text-slate-500">{tickerLabel(token.ticker)}</p><div className="mt-1.5"><TokenLabels token={token} compact /></div></div></div>;
}

function EmptyPanel({ title, body, action = false }: { title: string; body: string; action?: boolean }) {
  return <div className="px-6 py-12 text-center"><p className="font-semibold text-white">{title}</p><p className="mx-auto mt-2 max-w-lg text-sm font-medium leading-6 text-slate-400">{body}</p>{action && <LinkButton href="/tokens" className="mt-5">Explore tokens</LinkButton>}</div>;
}

function ProfileAvatar({ avatar, size = "normal" }: { avatar?: string; size?: "normal" | "large" }) {
  const sizeClass = size === "large" ? "size-16 rounded-2xl" : "size-14 rounded-2xl";
  return <div
    role={avatar ? "img" : undefined}
    aria-label={avatar ? "Profile avatar" : undefined}
    className={`grid shrink-0 place-items-center overflow-hidden border border-line bg-white/[.04] bg-cover bg-center text-slate-200 ${sizeClass}`}
    style={avatar ? { backgroundImage: `url(${avatar})` } : undefined}
  >{!avatar && <UserRound className={size === "large" ? "size-7" : "size-6"} />}</div>;
}

function ProfileEditor({
  username,
  preview,
  hasSavedAvatar,
  saving,
  error,
  onUsername,
  onChoose,
  onRemove,
  onClose,
  onSave,
}: {
  username: string;
  preview: string;
  hasSavedAvatar: boolean;
  saving: boolean;
  error: string;
  onUsername: (value: string) => void;
  onChoose: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemove: () => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return <div role="dialog" aria-modal="true" aria-labelledby="edit-profile-title" className="fixed inset-0 z-[90] grid place-items-center bg-black/75 p-4 backdrop-blur-md" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div className="w-full max-w-md overflow-hidden rounded-[24px] border border-line bg-[#0b101a] shadow-[0_30px_100px_rgba(0,0,0,.6)]">
      <div className="relative h-28 overflow-hidden border-b border-line bg-[radial-gradient(circle_at_50%_0%,rgba(57,189,248,.22),transparent_68%)]">
        <div className="absolute inset-0 grid-line opacity-50" />
        <button type="button" aria-label="Close profile editor" onClick={onClose} disabled={saving} className="absolute right-4 top-4 grid size-9 place-items-center rounded-xl border border-line bg-black/25 text-slate-300 transition hover:bg-white/[.06] hover:text-white disabled:opacity-60"><X className="size-4" /></button>
      </div>
      <div className="p-6">
        <div className="-mt-14 mb-6 flex items-end gap-3">
          <ProfileAvatar avatar={preview} size="large" />
          <label className="mb-1 inline-flex h-10 cursor-pointer items-center gap-2 rounded-[10px] border border-line bg-white/[.035] px-4 text-[13px] font-semibold text-slate-100 transition hover:bg-white/[.06]">
            <ImagePlus className="size-4" />Choose picture
            <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={onChoose} disabled={saving} />
          </label>
          {(preview || hasSavedAvatar) && <button type="button" aria-label="Remove profile picture" onClick={onRemove} disabled={saving} className="mb-1 grid size-10 place-items-center rounded-[10px] border border-rose-400/15 bg-rose-400/[.06] text-rose-300 transition hover:bg-rose-400/10 disabled:opacity-60"><Trash2 className="size-4" /></button>}
        </div>
        <div className="flex items-center gap-2">
          <h2 id="edit-profile-title" className="text-2xl font-semibold tracking-[-.04em] text-white">Edit profile</h2>
          <Badge tone="cyan">Wallet signed</Badge>
        </div>
        <p className="mt-2 text-sm font-medium leading-6 text-slate-400">Your username and avatar are public. Saving requires a free wallet signature, not a transaction.</p>
        <label className="label mt-6" htmlFor="profile-username">Username</label>
        <div className="relative">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-slate-500">@</span>
          <input
            id="profile-username"
            value={username}
            onChange={(event) => onUsername(event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20))}
            className="input pl-8"
            placeholder="your_username"
            autoComplete="off"
            disabled={saving}
          />
        </div>
        <p className="mt-2 text-xs font-medium text-slate-400">Optional · 3–20 lowercase letters, numbers, or underscores.</p>
        {error && <p role="alert" className="mt-4 rounded-xl border border-rose-400/20 bg-rose-400/[.07] px-3 py-2.5 text-sm font-medium leading-5 text-rose-200">{error}</p>}
        <div className="mt-6 flex items-center gap-2">
          <Button onClick={onSave} disabled={saving}>{saving ? "Waiting for signature…" : "Save profile"}</Button>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
        </div>
      </div>
    </div>
  </div>;
}
