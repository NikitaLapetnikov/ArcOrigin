"use client";

import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import { AtSign, ExternalLink, Globe, ImagePlus, LoaderCircle, Rocket, Send, X } from "lucide-react";
import {
  decodeEventLog,
  encodeFunctionData,
  formatUnits,
  isHash,
  parseUnits,
  publicActions,
  type Address,
  type Hash,
} from "viem";
import type SafeAppsSDK from "@safe-global/safe-apps-sdk";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient, useWriteContract } from "wagmi";
import {
  ARCORIGIN_PROTOCOL_VERSION,
  ARC_ACTIVE_CONTRACTS,
  EXPLORER_URL,
  arcChain,
} from "@/lib/chains";
import {
  DEFAULT_GRADUATION_THRESHOLD,
  DEFAULT_VIRTUAL_USDC_RESERVE,
} from "@/lib/bonding-curve";
import { bondingCurveAbi, erc20Abi, factoryAbi } from "@/lib/contracts";
import {
  TOKEN_IMAGE_INPUT_MAX_BYTES,
  TOKEN_IMAGE_MAX_BYTES,
  canonicalMetadataCommitment,
  validateTokenMetadataInput,
  type TokenMetadataInput,
} from "@/lib/token-metadata";
import { shortAddress, tickerLabel } from "@/lib/utils";
import { getSafeAppContext } from "@/lib/wallet/safe-app-connector";
import { Button, LinkButton, WarningBox } from "./ui";

type FormData = {
  name: string;
  ticker: string;
  description: string;
  website: string;
  x: string;
  telegram: string;
  developerBuy: string;
};

type TransactionStatus = "idle" | "checking" | "signing_metadata" | "uploading_metadata" | "approving" | "launching" | "safe_confirming" | "initial_buy_approving" | "initial_buy";
type LaunchResult = { token: Address; curve: Address; hash: Hash; metadataURI: string; metadataURL: string; initialBuyHash?: Hash; initialBuyError?: string };
type UploadedMetadata = {
  commitment: string;
  creator: Address;
  metadataURI: string;
  gatewayURL: string;
};

const defaults: FormData = {
  name: "",
  ticker: "",
  description: "",
  website: "",
  x: "",
  telegram: "",
  developerBuy: "0",
};
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const DEFAULT_LAUNCH_FEE = 10n * 10n ** 6n;
const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
const DISPLAY_NUMBER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function formatDisplayNumber(value: number) {
  return DISPLAY_NUMBER_FORMAT.format(value);
}

function transactionError(error: unknown) {
  const fallback = error instanceof Error ? error.message : "The wallet transaction failed.";
  if (/User rejected|User denied|rejected the request/i.test(fallback)) return "The request was cancelled in your wallet.";
  if (/RPC Request failed|HTTP request failed|fetch failed|Too Many Requests|\b429\b/i.test(fallback)) {
    return "Arc RPC is temporarily unavailable. Check your wallet activity or Arcscan before retrying because an approval or launch may already have been submitted.";
  }
  if (typeof error === "object" && error && "shortMessage" in error) return String(error.shortMessage);
  return fallback;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withRpcRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /RPC Request failed|HTTP request failed|fetch failed|Too Many Requests|rate limit|\b429\b/i.test(message);
      if (!retryable || attempt === attempts) throw error;
      await wait(attempt * 750);
    }
  }
  throw new Error("Arc RPC request failed after retries.");
}

async function waitForSafeExecution(
  sdk: SafeAppsSDK,
  safeTransactionHash: string,
): Promise<Hash> {
  const expiresAt = Date.now() + 15 * 60 * 1_000;
  while (Date.now() < expiresAt) {
    try {
      const transaction = await sdk.txs.getBySafeTxHash(safeTransactionHash);
      if (transaction.txStatus === "SUCCESS" && transaction.txHash && isHash(transaction.txHash)) {
        return transaction.txHash;
      }
      if (transaction.txStatus === "FAILED" || transaction.txStatus === "CANCELLED") {
        throw new Error(`Safe transaction ${transaction.txStatus.toLowerCase()}.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/failed|cancelled/i.test(message)) throw error;
      // The Safe service can need a few seconds before a new proposal is indexed.
    }
    await wait(2_000);
  }
  throw new Error(
    "Safe confirmation timed out. The proposal remains in the Safe queue; verify it there before retrying.",
  );
}

async function sha256Hex(value: ArrayBuffer | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `0x${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("The image could not be optimized.")),
    "image/webp",
    quality,
  ));
}

async function optimizeImage(file: File) {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error("Choose a PNG, JPG, or WebP image.");
  if (file.size > TOKEN_IMAGE_INPUT_MAX_BYTES) throw new Error("The original image must be 8 MB or smaller.");
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 40_000_000) throw new Error("Image dimensions are too large. Use an image below 40 megapixels.");
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Your browser could not process the image.");
    context.drawImage(bitmap, 0, 0, width, height);
    let blob = await canvasBlob(canvas, 0.86);
    if (blob.size > TOKEN_IMAGE_MAX_BYTES) blob = await canvasBlob(canvas, 0.68);
    if (blob.size > TOKEN_IMAGE_MAX_BYTES) throw new Error("The optimized image is still larger than 2 MB. Choose a simpler image.");
    return new File([blob], "token-image.webp", { type: "image/webp" });
  } finally {
    bitmap.close();
  }
}

export function LaunchForm() {
  const descriptionId = useId();
  const [form, setForm] = useState(defaults);
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState("");
  const [imageError, setImageError] = useState("");
  const [imageProcessing, setImageProcessing] = useState(false);
  const [status, setStatus] = useState<TransactionStatus>("idle");
  const [storageStatus, setStorageStatus] = useState<"unknown" | "available" | "unavailable">("unknown");
  const [uploadedMetadata, setUploadedMetadata] = useState<UploadedMetadata | null>(null);
  const [launchFee, setLaunchFee] = useState(DEFAULT_LAUNCH_FEE);
  const [tradingFees, setTradingFees] = useState({ buy: 100, sell: 100 });
  const [error, setError] = useState("");
  const [result, setResult] = useState<LaunchResult | null>(null);
  const previewUrl = useRef("");
  const launchLockRef = useRef(false);
  const { address, isConnected, chainId, connector } = useAccount();
  const publicClient = usePublicClient({ chainId: arcChain.id });
  const { data: walletClient } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  useEffect(() => {
    void fetch("/api/metadata/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: { available?: boolean }) => setStorageStatus(payload.available ? "available" : "unavailable"))
      .catch(() => setStorageStatus("unavailable"));
    return () => {
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    };
  }, []);

  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    void Promise.all([
      withRpcRetry(() => publicClient.readContract({
        address: ARC_ACTIVE_CONTRACTS.factory,
        abi: factoryAbi,
        functionName: "launchFee",
      }), 2),
      withRpcRetry(() => publicClient.readContract({
        address: ARC_ACTIVE_CONTRACTS.factory,
        abi: factoryAbi,
        functionName: "buyFeeBps",
      }), 2),
      withRpcRetry(() => publicClient.readContract({
        address: ARC_ACTIVE_CONTRACTS.factory,
        abi: factoryAbi,
        functionName: "sellFeeBps",
      }), 2),
    ]).then(([nextLaunchFee, buyFeeBps, sellFeeBps]) => {
      if (cancelled) return;
      setLaunchFee(nextLaunchFee);
      setTradingFees({ buy: Number(buyFeeBps), sell: Number(sellFeeBps) });
    }).catch(() => {
      // The launch transaction re-reads the fee before approving, so a failed preview read is safe.
    });
    return () => {
      cancelled = true;
    };
  }, [publicClient]);

  const metadataInput = useMemo<TokenMetadataInput>(() => ({
    name: form.name,
    symbol: form.ticker,
    description: form.description,
    website: form.website,
    x: form.x,
    telegram: form.telegram,
  }), [form.name, form.ticker, form.description, form.website, form.x, form.telegram]);

  const identityValid = useMemo(() => {
    try {
      validateTokenMetadataInput(metadataInput);
      return storageStatus === "available";
    } catch {
      return false;
    }
  }, [metadataInput, storageStatus]);
  const developerBuyMax = useMemo(() => {
    const curveTokens = 1_000_000_000;
    const maximumTokens = 50_000_000;
    if (curveTokens <= maximumTokens) return 0;
    const netUsdc = DEFAULT_VIRTUAL_USDC_RESERVE * maximumTokens / (curveTokens - maximumTokens);
    const netMultiplier = 1 - tradingFees.buy / 10_000;
    return netMultiplier > 0 ? Math.floor(netUsdc / netMultiplier * 100) / 100 : 0;
  }, [tradingFees.buy]);
  const developerBuyAmount = Math.max(0, Number(form.developerBuy) || 0);
  const safeLaunch = connector?.id === "safe";
  const developerBuyLimit = safeLaunch ? 0 : developerBuyMax;
  const launchFeeAmount = Number(formatUnits(launchFee, 6));
  const launchFeeLabel = `${formatDisplayNumber(launchFeeAmount)} USDC`;
  const tradingFeeLabel = tradingFees.buy === tradingFees.sell
    ? `${formatDisplayNumber(tradingFees.buy / 100)}% · 70/30 split`
    : `${formatDisplayNumber(tradingFees.buy / 100)}% buy · ${formatDisplayNumber(tradingFees.sell / 100)}% sell`;
  const totalWalletPayment = launchFeeAmount + developerBuyAmount;
  const canLaunch = identityValid
    && !imageProcessing
    && Number(form.developerBuy) >= 0
    && Number(form.developerBuy) <= developerBuyLimit;
  const isPending = status !== "idle";

  function update(key: keyof FormData, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
    setUploadedMetadata(null);
  }

  async function selectImage(file: File | null) {
    setImageError("");
    if (!file) return;
    setImageProcessing(true);
    try {
      const optimized = await optimizeImage(file);
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = URL.createObjectURL(optimized);
      setImage(optimized);
      setImagePreview(previewUrl.current);
      setUploadedMetadata(null);
    } catch (selectionError) {
      setImageError(selectionError instanceof Error ? selectionError.message : "The image could not be processed.");
    } finally {
      setImageProcessing(false);
    }
  }

  function removeImage() {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = "";
    setImage(null);
    setImagePreview("");
    setImageError("");
    setUploadedMetadata(null);
  }

  async function ensureMetadata(creator: Address) {
    if (!walletClient) throw new Error("Connect a wallet before uploading token metadata.");
    const normalized = validateTokenMetadataInput(metadataInput);
    const imageSha256 = image ? await sha256Hex(await image.arrayBuffer()) : "";
    const commitment = await sha256Hex(canonicalMetadataCommitment(normalized, imageSha256));
    if (uploadedMetadata?.commitment === commitment
      && uploadedMetadata.creator.toLowerCase() === creator.toLowerCase()) {
      return uploadedMetadata;
    }

    setStatus("signing_metadata");
    const challengeResponse = await fetch("/api/metadata/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: creator, commitment }),
    });
    const challenge = await challengeResponse.json() as { nonce?: string; message?: string; error?: string };
    if (!challengeResponse.ok || !challenge.nonce || !challenge.message) {
      throw new Error(challenge.error ?? "Metadata upload authorization failed.");
    }
    const signature = await walletClient.signMessage({ account: creator, message: challenge.message });

    setStatus("uploading_metadata");
    const body = new FormData();
    body.append("nonce", challenge.nonce);
    body.append("address", creator);
    body.append("signature", signature);
    body.append("name", normalized.name);
    body.append("symbol", normalized.symbol);
    body.append("description", normalized.description);
    body.append("website", normalized.website);
    body.append("x", normalized.x);
    body.append("telegram", normalized.telegram);
    if (image) body.append("image", image);
    const uploadResponse = await fetch("/api/metadata/upload", { method: "POST", body });
    const upload = await uploadResponse.json() as { metadataURI?: string; gatewayURL?: string; error?: string };
    if (!uploadResponse.ok || !upload.metadataURI || !upload.gatewayURL) {
      throw new Error(upload.error ?? "Token metadata upload failed.");
    }
    const uploaded = {
      commitment,
      creator,
      metadataURI: upload.metadataURI,
      gatewayURL: upload.gatewayURL,
    };
    setUploadedMetadata(uploaded);
    return uploaded;
  }

  async function launch() {
    if (!isConnected || !address) {
      setError("Connect your wallet in the header before launching a token.");
      return;
    }
    if (!publicClient && !walletClient) {
      setError(`${arcChain.name} RPC is unavailable. Try again in a moment.`);
      return;
    }

    if (launchLockRef.current) return;
    launchLockRef.current = true;
    setError("");
    setStatus("checking");
    try {
      if (chainId !== arcChain.id) {
        await switchChainAsync({ chainId: arcChain.id });
        throw new Error(`${arcChain.name} is now selected. Review and launch again.`);
      }
      const transactionClient = walletClient?.extend(publicActions) ?? publicClient;
      if (!transactionClient) throw new Error(`No ${arcChain.name} client is available.`);
      const balance = await withRpcRetry(() => transactionClient.readContract({
        address: ARC_ACTIVE_CONTRACTS.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      }));
      const currentLaunchFee = await withRpcRetry(() => transactionClient.readContract({
        address: ARC_ACTIVE_CONTRACTS.factory,
        abi: factoryAbi,
        functionName: "launchFee",
      }));
      setLaunchFee(currentLaunchFee);
      const developerBuy = parseUnits(form.developerBuy || "0", 6);
      if (safeLaunch && developerBuy > 0n) {
        throw new Error(
          "Safe launches must use a 0 USDC developer buy. Buy after launch with a separate, freshly quoted Safe transaction.",
        );
      }
      const requiredBalance = currentLaunchFee + developerBuy;
      if (balance < requiredBalance) {
        throw new Error(`You have ${formatUnits(balance, 6)} USDC, but launch plus developer buy requires ${formatUnits(requiredBalance, 6)} USDC.`);
      }

      const metadata = await ensureMetadata(address);
      const allowance = await withRpcRetry(() => transactionClient.readContract({
        address: ARC_ACTIVE_CONTRACTS.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, ARC_ACTIVE_CONTRACTS.factory],
      }));
      const launchParameters = {
          name: form.name.trim(),
          symbol: form.ticker.toUpperCase(),
          metadataURI: metadata.metadataURI,
      };
      let launchHash: Hash;
      if (safeLaunch) {
        const safeContext = await getSafeAppContext();
        if (!safeContext || safeContext.safe.safeAddress.toLowerCase() !== address.toLowerCase()) {
          throw new Error("Open ArcOrigin as a custom app inside the connected Safe and retry.");
        }
        const transactions = [];
        if (allowance < currentLaunchFee) {
          transactions.push({
            to: ARC_ACTIVE_CONTRACTS.usdc,
            value: "0",
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [ARC_ACTIVE_CONTRACTS.factory, currentLaunchFee],
            }),
          });
        }
        transactions.push({
          to: ARC_ACTIVE_CONTRACTS.factory,
          value: "0",
          data: encodeFunctionData({
            abi: factoryAbi,
            functionName: "launchToken",
            args: [launchParameters],
          }),
        });
        setStatus("safe_confirming");
        const proposal = await safeContext.sdk.txs.send({ txs: transactions });
        launchHash = await waitForSafeExecution(safeContext.sdk, proposal.safeTxHash);
      } else {
        if (allowance < currentLaunchFee) {
          setStatus("approving");
          const approvalHash = await writeContractAsync({
            address: ARC_ACTIVE_CONTRACTS.usdc,
            abi: erc20Abi,
            functionName: "approve",
            args: [ARC_ACTIVE_CONTRACTS.factory, currentLaunchFee],
          });
          const approvalReceipt = await withRpcRetry(() => transactionClient.waitForTransactionReceipt({ hash: approvalHash }));
          if (approvalReceipt.status !== "success") throw new Error("USDC approval reverted onchain.");
        }
        setStatus("launching");
        launchHash = await writeContractAsync({
          address: ARC_ACTIVE_CONTRACTS.factory,
          abi: factoryAbi,
          functionName: "launchToken",
          args: [launchParameters],
        });
      }
      const receipt = await withRpcRetry(() => transactionClient.waitForTransactionReceipt({ hash: launchHash }));
      if (receipt.status !== "success") throw new Error("Token launch reverted onchain.");

      let launched: LaunchResult | null = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== ARC_ACTIVE_CONTRACTS.factory.toLowerCase()) continue;
        try {
          const event = decodeEventLog({ abi: factoryAbi, eventName: "TokenLaunched", data: log.data, topics: log.topics });
          launched = { token: event.args.token, curve: event.args.curve, hash: launchHash, metadataURI: metadata.metadataURI, metadataURL: metadata.gatewayURL };
          break;
        } catch {
          // The receipt includes constructor and registry logs from other contracts.
        }
      }
      if (!launched) throw new Error("The launch succeeded, but its TokenLaunched event was not found.");
      if (developerBuy > 0n) {
        try {
          const curveAllowance = await withRpcRetry(() => transactionClient.readContract({
            address: ARC_ACTIVE_CONTRACTS.usdc,
            abi: erc20Abi,
            functionName: "allowance",
            args: [address, launched!.curve],
          }));
          if (curveAllowance < developerBuy) {
            setStatus("initial_buy_approving");
            const approvalHash = await writeContractAsync({
              address: ARC_ACTIVE_CONTRACTS.usdc,
              abi: erc20Abi,
              functionName: "approve",
              args: [launched.curve, developerBuy],
            });
            const approvalReceipt = await withRpcRetry(() => transactionClient.waitForTransactionReceipt({ hash: approvalHash }));
            if (approvalReceipt.status !== "success") throw new Error("Developer buy approval reverted onchain.");
          }
          const [tokensOut] = await withRpcRetry(() => transactionClient.readContract({
            address: launched!.curve,
            abi: bondingCurveAbi,
            functionName: "quoteBuy",
            args: [developerBuy],
          }));
          if (tokensOut <= 0n) throw new Error("The curve returned no tokens for the developer buy.");
          if (tokensOut > TOTAL_SUPPLY * 5n / 100n) {
            throw new Error("The current curve quote exceeds the 5% developer-buy cap. Reduce the USDC amount.");
          }
          setStatus("initial_buy");
          const initialBuyHash = await writeContractAsync(ARCORIGIN_PROTOCOL_VERSION === 6 ? {
            address: launched.curve,
            abi: bondingCurveAbi,
            functionName: "buy",
            args: [
              developerBuy,
              tokensOut * 95n / 100n,
              BigInt(Math.floor(Date.now() / 1_000) + 20 * 60),
            ],
          } : {
            address: launched.curve,
            abi: bondingCurveAbi,
            functionName: "buy",
            args: [developerBuy, tokensOut * 95n / 100n],
          });
          const initialBuyReceipt = await withRpcRetry(() => transactionClient.waitForTransactionReceipt({ hash: initialBuyHash }));
          if (initialBuyReceipt.status !== "success") throw new Error("Developer buy reverted onchain.");
          launched.initialBuyHash = initialBuyHash;
        } catch (buyError) {
          launched.initialBuyError = `Token launched successfully, but the optional developer buy did not complete: ${transactionError(buyError)}`;
        }
      }
      setResult(launched);
      window.localStorage.setItem(
        `arcorigin:${arcChain.id}:last-launch-confirmed-at`,
        String(Date.now()),
      );
      window.dispatchEvent(new CustomEvent("arcforge:launch-confirmed", {
        detail: { tokenAddress: launched.token, curveAddress: launched.curve, transactionHash: launchHash },
      }));
      void fetch("/api/onchain/tokens?refresh=1", { cache: "no-store" }).catch(() => undefined);
    } catch (launchError) {
      setError(transactionError(launchError));
    } finally {
      launchLockRef.current = false;
      setStatus("idle");
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canLaunch && !isPending) void launch();
  }

  function reset() {
    setResult(null);
    setForm(defaults);
    setUploadedMetadata(null);
    removeImage();
  }

  if (result) {
    return <div className="panel mx-auto max-w-2xl p-8 text-center md:p-10">
      <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-cyan/10 text-cyan"><Rocket /></div>
      <p className="eyebrow mt-6">Onchain launch confirmed</p>
      <h2 className="mt-3 text-3xl font-semibold text-white">{form.name} · {tickerLabel(form.ticker.toUpperCase())}</h2>
      <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-slate-400">Your token metadata is pinned to public IPFS and the fixed-supply token with its USDC curve is deployed on {arcChain.name}.</p>
      <dl className="mx-auto mt-6 grid max-w-lg gap-3 rounded-xl border border-line bg-black/25 p-4 text-left text-xs">
        <ResultRow label="Token" address={result.token} />
        <ResultRow label="Bonding curve" address={result.curve} />
        <ResultLink label="Metadata" href={result.metadataURL} value={result.metadataURI.slice(0, 22) + "…"} />
        <ResultLink label="Transaction" href={`${EXPLORER_URL}/tx/${result.hash}`} value={shortAddress(result.hash)} />
        {result.initialBuyHash && <ResultLink label="Developer buy" href={`${EXPLORER_URL}/tx/${result.initialBuyHash}`} value={shortAddress(result.initialBuyHash)} />}
      </dl>
      {result.initialBuyError && <p className="mx-auto mt-4 max-w-lg rounded-xl border border-amber-400/20 bg-amber-400/[.07] p-3 text-left text-xs leading-5 text-amber-100">{result.initialBuyError}</p>}
      <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
        <LinkButton href={`/tokens/${result.token}`}>Open token market</LinkButton>
        <Button variant="secondary" onClick={reset}>Create another</Button>
      </div>
    </div>;
  }

  const actionLabel = status === "checking"
    ? "Checking balance…"
    : status === "signing_metadata"
      ? connector?.id === "safe"
        ? "Approve metadata with Safe owners…"
        : "Sign metadata in wallet…"
      : status === "uploading_metadata"
        ? "Publishing to IPFS…"
        : status === "approving"
          ? `Approving ${launchFeeLabel}…`
          : status === "launching"
            ? "Launching on Arc…"
            : status === "safe_confirming"
              ? "Confirm launch with Safe owners…"
            : status === "initial_buy_approving"
              ? "Approving developer buy…"
              : status === "initial_buy"
                ? "Executing developer buy…"
                : "Launch token";

  return <form onSubmit={submit} className="overflow-hidden rounded-3xl border border-line bg-panel shadow-glow lg:grid lg:grid-cols-[minmax(0,1fr)_380px]">
    <div className="p-5 sm:p-8 lg:p-10">
      <div className="mb-8">
        <h1 className="text-[34px] font-semibold tracking-[-.045em] text-white sm:text-[40px]">Launch token</h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-slate-400">Create a fixed-supply token with a USDC bonding curve.</p>
      </div>

      <div className="grid gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required value={form.name} onChange={(value) => update("name", value)} placeholder="Token name" maxLength={64} />
          <Field label="Ticker" required value={form.ticker} onChange={(value) => update("ticker", value.toUpperCase())} placeholder="SYMBOL" maxLength={10} />
        </div>

        <label htmlFor={descriptionId}>
          <span className="label">Description *</span>
          <textarea id={descriptionId} className="input min-h-28 resize-y py-3" required value={form.description} onChange={(event) => update("description", event.target.value)} placeholder="A short description of the token" />
        </label>

        <div className="grid gap-5 md:grid-cols-[160px_minmax(0,1fr)]">
          <ImagePicker preview={imagePreview} processing={imageProcessing} error={imageError} onSelect={selectImage} onRemove={removeImage} />
          <div className="grid content-start gap-4">
            <Field icon={<Globe className="size-4" />} label="Website (optional)" value={form.website} onChange={(value) => update("website", value)} placeholder="https://yourproject.xyz" maxLength={200} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field icon={<AtSign className="size-4" />} label="X / Twitter (optional)" value={form.x} onChange={(value) => update("x", value)} placeholder="@yourproject" maxLength={200} />
              <Field icon={<Send className="size-4" />} label="Telegram (optional)" value={form.telegram} onChange={(value) => update("telegram", value)} placeholder="t.me/community" maxLength={200} />
            </div>
          </div>
        </div>

        <div>
          <Field label="Developer buy (optional)" value={form.developerBuy} onChange={(value) => update("developerBuy", value)} type="number" min="0" max={String(developerBuyLimit)} step="0.01" />
          <p className="mt-2 text-[11px] leading-5 text-slate-500">
            {safeLaunch
              ? "Safe launch uses 0 USDC here. A treasury purchase can be proposed separately after launch."
              : `Separate USDC purchase after launch · maximum ${formatDisplayNumber(developerBuyMax)} USDC or 5% of supply.`}
          </p>
          {Number(form.developerBuy) > developerBuyLimit && <p className="mt-2 text-xs text-rose-300">Reduce the developer buy to {formatDisplayNumber(developerBuyLimit)} USDC.</p>}
        </div>

        <div className="grid overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2">
          <PaymentSummary label="Launch fee" value={launchFeeLabel} />
          <PaymentSummary label="Total wallet payment" value={`${formatDisplayNumber(totalWalletPayment)} USDC`} />
        </div>

        {storageStatus === "unavailable" && <WarningBox>Token metadata storage is temporarily unavailable. Launching is disabled until it reconnects.</WarningBox>}
        {error && <p role="alert" className="rounded-xl border border-rose-400/20 bg-rose-400/[.07] p-3 text-xs leading-5 text-rose-200">{error}</p>}

        <Button className="mt-1 h-12 w-full text-sm" type="submit" disabled={!canLaunch || isPending}>
          {isPending && <LoaderCircle className="size-4 animate-spin" />}
          {actionLabel}
        </Button>
        <p className="text-center text-[11px] leading-5 text-slate-500">
          Token metadata is public on IPFS. Your wallet will show each required approval and transaction before submission.
        </p>
      </div>
    </div>

    <aside className="border-t border-line bg-black/15 p-6 sm:p-8 lg:border-l lg:border-t-0">
      <div className="mx-auto max-w-[310px] lg:sticky lg:top-24 lg:pt-12">
        <div className="rounded-2xl border border-line bg-[#0a0f18] p-6 shadow-[0_24px_70px_rgba(0,0,0,.28)]">
          <div className="grid size-20 place-items-center overflow-hidden rounded-2xl border border-cyan/20 bg-cyan/[.08] font-mono text-sm font-semibold text-cyan">
            {imagePreview ? <span role="img" aria-label="Token preview" className="size-full bg-cover bg-center" style={{ backgroundImage: `url(${imagePreview})` }} /> : form.ticker.slice(0, 2) || "—"}
          </div>
          <p className="mt-6 truncate text-2xl font-semibold tracking-[-.03em] text-white">{form.name || "Your token"}</p>
          <p className="mt-1 font-mono text-xs text-slate-500">{form.ticker ? tickerLabel(form.ticker) : "$TICKER"}</p>
          {form.description && <p className="mt-4 line-clamp-3 text-xs leading-5 text-slate-500">{form.description}</p>}
          {(form.website || form.x || form.telegram) && <div className="mt-4 flex flex-wrap gap-2">{form.website && <PreviewTag icon={<Globe className="size-3" />} label="Website" />}{form.x && <PreviewTag icon={<AtSign className="size-3" />} label="X" />}{form.telegram && <PreviewTag icon={<Send className="size-3" />} label="Telegram" />}</div>}
          <dl className="mt-6 grid gap-3 border-t border-line pt-5 text-xs">
            <Row label="Supply" value="1 billion" />
            <Row label="Launch fee" value={launchFeeLabel} />
            <Row label="Trading fee" value={tradingFeeLabel} />
            <Row label="Graduation" value={`${formatDisplayNumber(DEFAULT_GRADUATION_THRESHOLD)} USDC`} />
            <Row label="Developer buy" value={`${formatDisplayNumber(developerBuyAmount)} USDC`} />
            <Row label="Network" value={arcChain.name} />
          </dl>
        </div>
      </div>
    </aside>
  </form>;
}

function ImagePicker({ preview, processing, error, onSelect, onRemove }: { preview: string; processing: boolean; error: string; onSelect: (file: File | null) => Promise<void>; onRemove: () => void }) {
  function accept(event: ChangeEvent<HTMLInputElement>) {
    void onSelect(event.target.files?.[0] ?? null);
    event.target.value = "";
  }
  function drop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    void onSelect(event.dataTransfer.files?.[0] ?? null);
  }
  return <div>
    <span className="label">Token image (optional)</span>
    <label onDragOver={(event) => event.preventDefault()} onDrop={drop} className="relative grid aspect-square cursor-pointer place-items-center overflow-hidden rounded-2xl border border-dashed border-line bg-black/20 text-center transition hover:border-cyan/40 hover:bg-cyan/[.025]">
      <input type="file" className="sr-only" accept={IMAGE_TYPES.join(",")} onChange={accept} />
      {preview ? <span role="img" aria-label="Selected token" className="size-full bg-cover bg-center" style={{ backgroundImage: `url(${preview})` }} /> : <div className="p-4"><ImagePlus className="mx-auto size-6 text-cyan"/><p className="mt-3 text-xs font-medium text-slate-300">Choose image</p><p className="mt-1 text-[10px] leading-4 text-slate-600">PNG, JPG, WebP<br/>up to 8 MB</p></div>}
      {processing && <div className="absolute inset-0 grid place-items-center bg-ink/80"><LoaderCircle className="size-5 animate-spin text-cyan" /></div>}
    </label>
    {preview && <button type="button" onClick={onRemove} className="mt-2 inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-white"><X className="size-3" /> Remove</button>}
    {error && <p className="mt-2 text-[10px] leading-4 text-rose-300">{error}</p>}
  </div>;
}

function ResultRow({ label, address }: { label: string; address: Address }) {
  return <ResultLink label={label} href={`${EXPLORER_URL}/address/${address}`} value={shortAddress(address)} />;
}

function ResultLink({ label, href, value }: { label: string; href: string; value: string }) {
  return <div className="flex items-center justify-between gap-4"><dt className="text-slate-500">{label}</dt><dd><a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-cyan hover:underline">{value}<ExternalLink className="size-3" /></a></dd></div>;
}

function Field({ label, value, onChange, icon, ...props }: { label: string; value: string; onChange: (value: string) => void; icon?: React.ReactNode } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const inputId = useId();
  return <label htmlFor={inputId}><span className="label">{label}{props.required && " *"}</span><span className="relative block">{icon && <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-600">{icon}</span>}<input id={inputId} className={`input ${icon ? "pl-10" : ""}`} value={value} onChange={(event) => onChange(event.target.value)} {...props} /></span></label>;
}

function PreviewTag({ icon, label }: { icon: React.ReactNode; label: string }) {
  return <span className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white/[.025] px-2 py-1 text-[10px] text-slate-400">{icon}{label}</span>;
}

function PaymentSummary({ label, value }: { label: string; value: string }) {
  return <div className="bg-[#090e17] px-4 py-3.5">
    <p className="text-[11px] text-slate-500">{label}</p>
    <p className="mt-1.5 text-sm font-semibold text-white">{value}</p>
  </div>;
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><dt className="text-slate-500">{label}</dt><dd className="text-right text-slate-200">{value}</dd></div>;
}
