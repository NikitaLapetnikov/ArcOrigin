"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Copy, ExternalLink, ImagePlus, LogOut, Pencil, RefreshCw, Share2, Trash2, UserRound, X } from "lucide-react";
import { formatUnits, type Address } from "viem";
import { useAccount, useDisconnect, useReadContracts, useWalletClient } from "wagmi";
import { useFactoryTokenIndex } from "@/hooks/use-factory-token-index";
import { arcTestnet, EXPLORER_URL } from "@/lib/chains";
import { erc20Abi } from "@/lib/contracts";
import type { TokenData, Trade } from "@/lib/types";
import { money, number, shortAddress, tickerLabel, utcDateTime } from "@/lib/utils";
import { Badge, Button, LinkButton, TokenIcon, WarningBox } from "@/components/ui";

type ProfileTab = "Positions" | "History" | "Activity" | "Launches";
type WalletTrade = { token: TokenData; trade: Trade };
type WalletProfile = { address: Address; username: string; avatar: string; updatedAt: string };
type Position = {
  token: TokenData;
  balance: number;
  value: number;
  bought: number;
  sold: number;
  pnl: number | null;
};

const tabs: ProfileTab[] = ["Positions", "History", "Activity", "Launches"];
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

export function ProfileDashboard() {
  const { address, isConnected, chainId } = useAccount();
  const { disconnect } = useDisconnect();
  const { data: walletClient } = useWalletClient();
  const { tokens, loading, error, refresh, isPartial } = useFactoryTokenIndex();
  const [activeTab, setActiveTab] = useState<ProfileTab>("Positions");
  const [actionMessage, setActionMessage] = useState("");
  const [profile, setProfile] = useState<WalletProfile | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editUsername, setEditUsername] = useState("");
  const [editImage, setEditImage] = useState<File | null>(null);
  const [editPreview, setEditPreview] = useState("");
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [editError, setEditError] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const balanceReads = useReadContracts({
    contracts: tokens.map((token) => ({
      address: token.address as Address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address ?? "0x0000000000000000000000000000000000000000"],
      chainId: arcTestnet.id,
    })),
    query: {
      enabled: Boolean(address) && tokens.length > 0 && chainId === arcTestnet.id,
      staleTime: 10_000,
      refetchInterval: 15_000,
    },
    allowFailure: true,
  });

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

  const walletTrades = useMemo(() => {
    if (!address) return [];
    const normalized = address.toLowerCase();
    return tokens.flatMap((token) => token.recentTrades
      .filter((trade) => trade.wallet.toLowerCase() === normalized)
      .map((trade): WalletTrade => ({ token, trade })))
      .sort((left, right) => (right.trade.timestamp ?? 0) - (left.trade.timestamp ?? 0));
  }, [address, tokens]);

  const positions = useMemo(() => tokens.map((token, index): Position | null => {
    const rawBalance = balanceReads.data?.[index]?.result;
    if (typeof rawBalance !== "bigint" || rawBalance <= 0n) return null;
    const balance = Number(formatUnits(rawBalance, 18));
    const trades = walletTrades.filter((item) => item.token.address.toLowerCase() === token.address.toLowerCase());
    const bought = trades.filter(({ trade }) => trade.type === "Buy").reduce((sum, { trade }) => sum + trade.usdc, 0);
    const sold = trades.filter(({ trade }) => trade.type === "Sell").reduce((sum, { trade }) => sum + trade.usdc, 0);
    const tradedBalance = trades.reduce((sum, { trade }) => sum + (trade.type === "Buy" ? trade.tokens : -trade.tokens), 0);
    const reconciled = Math.abs(balance - Math.max(0, tradedBalance)) <= Math.max(0.000001, balance * 1e-9);
    const value = balance * token.price;
    return { token, balance, value, bought, sold, pnl: reconciled && bought > 0 ? sold + value - bought : null };
  }).filter((position): position is Position => Boolean(position)), [balanceReads.data, tokens, walletTrades]);

  const launches = useMemo(() => {
    if (!address) return [];
    return tokens.filter((token) => token.creator.toLowerCase() === address.toLowerCase())
      .sort((left, right) => (right.launchedAt ?? 0) - (left.launchedAt ?? 0));
  }, [address, tokens]);
  const portfolioValue = positions.reduce((sum, position) => sum + position.value, 0);
  const confirmedVolume = walletTrades.reduce((sum, { trade }) => sum + trade.usdc, 0);

  async function copyAddress() {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    setActionMessage("Address copied");
  }

  async function shareProfile() {
    if (!address) return;
    const url = `${window.location.origin}/profile`;
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
    if (!address || !walletClient) {
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
      const signature = await walletClient.signMessage({ account: address, message: challenge.message });
      const body = new FormData();
      body.append("nonce", challenge.nonce);
      body.append("address", address);
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

  if (!isConnected || !address) return <div className="container-shell py-14">
    <div className="mx-auto max-w-xl rounded-2xl border border-line bg-panel p-8 text-center shadow-glow">
      <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-line bg-white/[.03] text-slate-300"><UserRound className="size-6" /></div>
      <h1 className="mt-5 text-2xl font-semibold tracking-[-.035em] text-white">Connect your wallet</h1>
      <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-slate-400">Connect from the header to view confirmed positions, trades, activity, and launches associated with your wallet.</p>
      <LinkButton href="/tokens" variant="secondary" className="mt-6">Explore tokens</LinkButton>
    </div>
  </div>;

  return <div className="container-shell py-8 md:py-12">
    <section className="overflow-hidden rounded-[22px] border border-line bg-panel shadow-glow">
      <div className="flex flex-col gap-5 border-b border-line p-5 sm:p-7 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <ProfileAvatar avatar={profile?.avatar} size="large" />
          <div className="min-w-0">
            <h1 className="break-safe text-xl font-semibold tracking-[-.035em] text-white sm:text-2xl">{profile?.username ? `@${profile.username}` : address}</h1>
            <p className="mt-1 text-sm font-medium text-slate-400">{profile?.username ? address : "Your ArcOrigin profile"}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={openProfileEditor}><Pencil className="size-4" />Edit profile</Button>
          <Button variant="secondary" onClick={() => void copyAddress()}><Copy className="size-4" />Copy address</Button>
          <Button variant="secondary" onClick={() => void shareProfile()}><Share2 className="size-4" />Share</Button>
          <a href={`${EXPLORER_URL}/address/${address}`} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center justify-center gap-2 rounded-[10px] border border-line bg-white/[.035] px-4 text-[13px] font-semibold text-slate-100 transition hover:bg-white/[.06]">Arcscan <ExternalLink className="size-4" /></a>
          <Button variant="danger" onClick={() => disconnect()}><LogOut className="size-4" />Disconnect</Button>
        </div>
      </div>
      <div className="p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <p className="text-[15px] font-medium text-slate-300">Portfolio value</p>
            <p className="mt-2 text-[42px] font-semibold leading-none tracking-[-.055em] text-white sm:text-[52px]">{balanceReads.isPending ? "—" : money(portfolioValue)}</p>
            <p className="mt-3 text-[14px] font-medium text-slate-400">{positions.length} open position{positions.length === 1 ? "" : "s"} · {money(confirmedVolume)} total trade volume</p>
          </div>
          <div className="flex items-center gap-2">
            {isPartial && <Badge tone="warn">Partial market data</Badge>}
            <Button variant="secondary" disabled={loading} onClick={() => {
              void refresh(true);
              void balanceReads.refetch();
            }}><RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button>
          </div>
        </div>
        <div className="relative mt-7 h-[210px] overflow-hidden rounded-2xl border border-line bg-black/15">
          <div className="absolute inset-0 opacity-60 grid-line" />
          <div className="absolute inset-x-5 bottom-10 border-t border-cyan/55">
            <span className="absolute -right-1 -top-1.5 size-3 rounded-full border-2 border-[#0a101a] bg-cyan shadow-[0_0_18px_rgba(57,189,248,.7)]" />
          </div>
          <div className="absolute bottom-4 left-5 right-5 flex items-center justify-between text-xs font-medium text-slate-400"><span>Current value</span><span>{money(portfolioValue)}</span></div>
          <p className="absolute left-5 top-5 max-w-md text-[13px] font-medium leading-5 text-slate-400">Portfolio history will appear when complete historical pricing is available.</p>
        </div>
      </div>
    </section>

    <section className="mt-5 overflow-hidden rounded-[22px] border border-line bg-panel shadow-glow">
      <div className="flex gap-1 overflow-x-auto border-b border-line px-4 pt-3 sm:px-6" role="tablist" aria-label="Profile data">
        {tabs.map((tab) => <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} onClick={() => setActiveTab(tab)} className={activeTab === tab ? "border-b-2 border-cyan px-4 py-3 text-sm font-semibold text-white" : "border-b-2 border-transparent px-4 py-3 text-sm font-semibold text-slate-400 transition hover:text-white"}>
          {tab}{tab === "Positions" && positions.length > 0 ? ` (${positions.length})` : tab === "History" && walletTrades.length > 0 ? ` (${walletTrades.length})` : tab === "Launches" && launches.length > 0 ? ` (${launches.length})` : ""}
        </button>)}
      </div>
      {activeTab === "Positions" && <PositionsTable positions={positions} loading={balanceReads.isPending} />}
      {activeTab === "History" && <HistoryTable trades={walletTrades} />}
      {activeTab === "Activity" && <ActivityFeed trades={walletTrades} launches={launches} />}
      {activeTab === "Launches" && <LaunchGrid tokens={launches} />}
      {error && <div className="px-5 pb-5"><WarningBox>{error}</WarningBox></div>}
      {actionMessage && <p className="border-t border-line px-6 py-3 text-xs text-emerald-300">{actionMessage}</p>}
    </section>
    {editOpen && <ProfileEditor
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
  </table><p className="border-t border-line px-6 py-3 text-xs font-medium leading-5 text-slate-400">PnL appears only when the actual ERC-20 balance matches confirmed curve trades. Transfers can make cost basis unavailable.</p></div>;
}

function HistoryTable({ trades }: { trades: WalletTrade[] }) {
  if (trades.length === 0) return <EmptyPanel title="No confirmed trades" body="Wallet buys and sells will appear here after their Arc Testnet transaction is confirmed." action />;
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
    <div className="flex items-center gap-3"><TokenIcon label={token.icon} image={token.image} className="size-12 rounded-xl" /><div className="min-w-0"><p className="truncate font-semibold text-white">{token.name}</p><p className="mt-1 font-mono text-xs text-slate-500">{tickerLabel(token.ticker)}</p></div></div>
    <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-xs"><span className="text-slate-500">{utcDateTime(token.launchedAt)}</span><span className="text-slate-300">{money(token.marketCap, true)} MC</span></div>
  </Link>)}</div>;
}

function TokenLabel({ token, compact = false }: { token: TokenData; compact?: boolean }) {
  return <div className="flex items-center gap-3"><TokenIcon label={token.icon} image={token.image} className={compact ? "size-8 rounded-lg" : "size-10 rounded-xl"} /><div className="min-w-0"><p className="truncate font-semibold text-white">{token.name}</p><p className="mt-0.5 font-mono text-[10px] text-slate-500">{tickerLabel(token.ticker)}</p></div></div>;
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
        <button type="button" aria-label="Close profile editor" onClick={onClose} disabled={saving} className="absolute right-4 top-4 grid size-9 place-items-center rounded-xl border border-line bg-black/25 text-slate-300 transition hover:bg-white/[.06] hover:text-white disabled:opacity-40"><X className="size-4" /></button>
      </div>
      <div className="p-6">
        <div className="-mt-14 mb-6 flex items-end gap-3">
          <ProfileAvatar avatar={preview} size="large" />
          <label className="mb-1 inline-flex h-10 cursor-pointer items-center gap-2 rounded-[10px] border border-line bg-white/[.035] px-4 text-[13px] font-semibold text-slate-100 transition hover:bg-white/[.06]">
            <ImagePlus className="size-4" />Choose picture
            <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={onChoose} disabled={saving} />
          </label>
          {(preview || hasSavedAvatar) && <button type="button" aria-label="Remove profile picture" onClick={onRemove} disabled={saving} className="mb-1 grid size-10 place-items-center rounded-[10px] border border-rose-400/15 bg-rose-400/[.06] text-rose-300 transition hover:bg-rose-400/10 disabled:opacity-40"><Trash2 className="size-4" /></button>}
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
