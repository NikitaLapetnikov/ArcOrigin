"use client";

import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import { AtSign, ExternalLink, Globe, ImagePlus, LoaderCircle, Rocket, Send, X } from "lucide-react";
import {
  decodeEventLog,
  encodeFunctionData,
  formatUnits,
  isAddress,
  isHash,
  parseUnits,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";
import type SafeAppsSDK from "@safe-global/safe-apps-sdk";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient, useWriteContract } from "wagmi";
import { requiredNativeUsdcBalance } from "@/lib/arc-usdc";
import {
  ARCORIGIN_CROSS_MARKET_CAP_USDC,
  ARC_ACTIVE_CONTRACTS,
  ARC_UNISWAP_V3,
  EXPLORER_URL,
  arcChain,
} from "@/lib/chains";
import {
  erc20Abi,
  factoryAbi,
  uniswapV3PoolAbi,
  uniswapV3QuoterAbi,
  uniswapV3RouterAbi,
} from "@/lib/contracts";
import {
  TOKEN_IMAGE_INPUT_MAX_BYTES,
  TOKEN_IMAGE_MAX_BYTES,
  TOKEN_DESCRIPTION_MAX_CHARACTERS,
  canonicalMetadataCommitment,
  validateTokenMetadataInput,
  type TokenMetadataInput,
} from "@/lib/token-metadata";
import { isRetryableRpcError, isRpcCapacityError, rpcErrorText } from "@/lib/rpc-errors";
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
  automaticBuyback: boolean;
  initialBuyUsdc: string;
};

type TransactionStatus =
  | "idle"
  | "checking"
  | "signing_metadata"
  | "uploading_metadata"
  | "approving"
  | "launching"
  | "safe_confirming"
  | "quoting_initial_buy"
  | "approving_initial_buy"
  | "buying_initial"
  | "safe_initial_buy";
type LaunchResult = {
  token: Address;
  pool: Address;
  hash: Hash;
  metadataURI: string;
  metadataURL: string;
  initialBuyHash?: Hash;
  initialBuyUsdc?: bigint;
  initialBuyTokens?: bigint;
  initialBuyError?: string;
};
type InitialBuyQuote = {
  input: bigint;
  output: bigint;
  minimumOutput: bigint;
  spender: Address;
  pool: Address;
};
type InitialBuyQuoteResponse = {
  output?: string;
  spender?: string;
  pool?: string;
  error?: string;
};
type UploadedMetadata = {
  commitment: string;
  creator: Address;
  metadataURI: string;
  gatewayURL: string;
};
type TransactionFeeOverrides =
  | { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | { gasPrice: bigint };

const defaults: FormData = {
  name: "",
  ticker: "",
  description: "",
  website: "",
  x: "",
  telegram: "",
  automaticBuyback: false,
  initialBuyUsdc: "",
};
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const DEFAULT_LAUNCH_FEE = 1n * 10n ** 6n;
const MAX_INITIAL_BUY_USDC = 100n * 10n ** 6n;
const INITIAL_BUY_SLIPPAGE_BPS = 1_000n;
const INITIAL_BUY_PRESETS = [10, 25, 50, 100] as const;
const DISPLAY_NUMBER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function formatDisplayNumber(value: number) {
  return DISPLAY_NUMBER_FORMAT.format(value);
}

function parseInitialBuyUsdc(value: string) {
  const normalized = value.trim();
  if (!normalized) return 0n;
  if (!/^\d+(?:\.\d{0,6})?$/.test(normalized)) return null;
  try {
    const amount = parseUnits(normalized, 6);
    return amount >= 0n && amount <= MAX_INITIAL_BUY_USDC ? amount : null;
  } catch {
    return null;
  }
}

function transactionError(error: unknown) {
  const details = rpcErrorText(error);
  const fallback = typeof error === "object" && error && "shortMessage" in error
    ? String(error.shortMessage)
    : error instanceof Error
      ? error.message
      : "The wallet transaction failed.";
  if (/User rejected|User denied|rejected the request/i.test(details || fallback)) return "The request was cancelled in your wallet.";
  if (isRpcCapacityError(error)) {
    return "Arc RPC is busy. Check your wallet activity before retrying because an approval or launch may already have been submitted.";
  }
  if (isRetryableRpcError(error)) {
    return "Arc RPC is temporarily unavailable. Check your wallet activity or Arcscan before retrying because an approval or launch may already have been submitted.";
  }
  return fallback;
}

function initialBuyErrorMessage(error: unknown) {
  const details = rpcErrorText(error);
  const fallback = typeof error === "object" && error && "shortMessage" in error
    ? String(error.shortMessage)
    : error instanceof Error
      ? error.message
      : "The optional initial buy failed.";
  if (/User rejected|User denied|rejected the request/i.test(details || fallback)) {
    return "The optional initial buy was cancelled in your wallet.";
  }
  if (/Too little received|amountOutMinimum|price impact|slippage|SPL/i.test(details)) {
    return "The price moved beyond the 10% protection limit, so the optional initial buy was not executed.";
  }
  if (isRpcCapacityError(error)) {
    return "Arc RPC is busy. Check wallet activity before retrying because the optional initial buy may already have been submitted.";
  }
  if (isRetryableRpcError(error)) {
    return "Arc RPC is temporarily unavailable. Check wallet activity or Arcscan before retrying the optional initial buy.";
  }
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
      if (!isRetryableRpcError(error) || attempt === attempts) throw error;
      await wait(attempt * 750);
    }
  }
  throw new Error("Arc RPC request failed after retries.");
}

async function readInitialBuyQuote(
  client: PublicClient,
  token: Address,
  pool: Address,
  input: bigint,
): Promise<InitialBuyQuote> {
  const quoteController = new AbortController();
  const serverQuote = (async () => {
    const response = await fetch(
      `/api/onchain/quote?token=${encodeURIComponent(token)}&pool=${encodeURIComponent(pool)}&side=Buy&amount=${input}`,
      { cache: "no-store", signal: quoteController.signal },
    );
    const payload = await response.json() as InitialBuyQuoteResponse;
    if (!response.ok) throw new Error(payload.error || "The initial buy quote is unavailable.");
    return payload;
  })();
  const directQuote = (async (): Promise<InitialBuyQuoteResponse> => {
    await wait(350);
    if (quoteController.signal.aborted) throw new Error("Direct initial buy quote cancelled.");
    const { result } = await client.simulateContract({
      address: ARC_UNISWAP_V3.quoter,
      abi: uniswapV3QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{
        tokenIn: ARC_ACTIVE_CONTRACTS.usdc,
        tokenOut: token,
        amountIn: input,
        fee: ARC_UNISWAP_V3.fee,
        sqrtPriceLimitX96: 0n,
      }],
    });
    return {
      output: result[0].toString(),
      spender: ARC_UNISWAP_V3.router,
      pool,
    };
  })();

  let payload: InitialBuyQuoteResponse;
  try {
    payload = await Promise.any([serverQuote, directQuote]);
  } finally {
    quoteController.abort();
  }
  if (!payload.output || !payload.spender || !payload.pool) {
    throw new Error(payload.error || "The initial buy quote is incomplete.");
  }
  if (!isAddress(payload.spender)
    || payload.spender.toLowerCase() !== ARC_UNISWAP_V3.router.toLowerCase()
    || !isAddress(payload.pool)
    || payload.pool.toLowerCase() !== pool.toLowerCase()) {
    throw new Error("The initial buy quote did not return the canonical ArcOrigin market.");
  }
  const output = BigInt(payload.output);
  if (output <= 0n) throw new Error("The initial buy quote returned zero tokens.");
  return {
    input,
    output,
    minimumOutput: output * (10_000n - INITIAL_BUY_SLIPPAGE_BPS) / 10_000n,
    spender: payload.spender,
    pool: payload.pool,
  };
}

function gasWithSafetyMargin(estimate: bigint) {
  return estimate * 125n / 100n + 20_000n;
}

async function transactionFees(client: PublicClient): Promise<TransactionFeeOverrides> {
  const fees = await withRpcRetry(() => client.estimateFeesPerGas());
  if (fees.maxFeePerGas !== undefined && fees.maxPriorityFeePerGas !== undefined) {
    return {
      maxFeePerGas: fees.maxFeePerGas * 110n / 100n,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas * 110n / 100n,
    };
  }
  return { gasPrice: await withRpcRetry(() => client.getGasPrice()) };
}

async function ensureGasBalance(
  client: PublicClient,
  account: Address,
  gas: bigint,
  fees: TransactionFeeOverrides,
  requiredUsdc = 0n,
) {
  const feePerGas = "gasPrice" in fees ? fees.gasPrice : fees.maxFeePerGas;
  const nativeBalance = await withRpcRetry(() => client.getBalance({ address: account }));
  const requiredNativeBalance = requiredNativeUsdcBalance(gas, feePerGas, requiredUsdc);
  if (nativeBalance < requiredNativeBalance) {
    throw new Error(requiredUsdc > 0n
      ? "Insufficient USDC balance for the launch fee and network gas."
      : "Insufficient native USDC balance for gas.");
  }
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
    void withRpcRetry(() => publicClient.readContract({
      address: ARC_ACTIVE_CONTRACTS.factory,
      abi: factoryAbi,
      functionName: "launchFee",
    }), 2).then((nextLaunchFee) => {
      if (!cancelled) setLaunchFee(nextLaunchFee);
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
  const safeLaunch = connector?.id === "safe";
  const launchFeeAmount = Number(formatUnits(launchFee, 6));
  const launchFeeLabel = `${formatDisplayNumber(launchFeeAmount)} USDC`;
  const initialBuyAmount = parseInitialBuyUsdc(form.initialBuyUsdc);
  const initialBuyValid = initialBuyAmount !== null;
  const initialBuyLabel = initialBuyAmount && initialBuyAmount > 0n
    ? `${formatUnits(initialBuyAmount, 6)} USDC`
    : "None";
  const canLaunch = identityValid && !imageProcessing && initialBuyValid;
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

  async function executeInitialBuy(
    transactionClient: PublicClient,
    creator: Address,
    launched: LaunchResult,
    input: bigint,
    safeSdk?: SafeAppsSDK,
  ) {
    const [balance, allowance] = await Promise.all([
      withRpcRetry(() => transactionClient.readContract({
        address: ARC_ACTIVE_CONTRACTS.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [creator],
      })),
      withRpcRetry(() => transactionClient.readContract({
        address: ARC_ACTIVE_CONTRACTS.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [creator, ARC_UNISWAP_V3.router],
      })),
    ]);
    if (balance < input) {
      throw new Error(`The token launched, but the wallet no longer has ${formatUnits(input, 6)} USDC for the initial buy.`);
    }

    setStatus("quoting_initial_buy");
    let quote = await readInitialBuyQuote(transactionClient, launched.token, launched.pool, input);
    let buyHash: Hash;

    if (safeSdk) {
      const transactions = [];
      if (allowance < input) {
        transactions.push({
          to: ARC_ACTIVE_CONTRACTS.usdc,
          value: "0",
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [ARC_UNISWAP_V3.router, input],
          }),
        });
      }
      transactions.push({
        to: ARC_UNISWAP_V3.router,
        value: "0",
        data: encodeFunctionData({
          abi: uniswapV3RouterAbi,
          functionName: "exactInputSingle",
          args: [{
            tokenIn: ARC_ACTIVE_CONTRACTS.usdc,
            tokenOut: launched.token,
            fee: ARC_UNISWAP_V3.fee,
            recipient: creator,
            amountIn: quote.input,
            amountOutMinimum: quote.minimumOutput,
            sqrtPriceLimitX96: 0n,
          }],
        }),
      });
      setStatus("safe_initial_buy");
      const proposal = await safeSdk.txs.send({ txs: transactions });
      buyHash = await waitForSafeExecution(safeSdk, proposal.safeTxHash);
    } else {
      if (allowance < input) {
        setStatus("approving_initial_buy");
        const approvalArgs = [ARC_UNISWAP_V3.router, input] as const;
        const approvalGas = gasWithSafetyMargin(await withRpcRetry(() => transactionClient.estimateContractGas({
          account: creator,
          address: ARC_ACTIVE_CONTRACTS.usdc,
          abi: erc20Abi,
          functionName: "approve",
          args: approvalArgs,
        })));
        const approvalFees = await transactionFees(transactionClient);
        await ensureGasBalance(transactionClient, creator, approvalGas, approvalFees, input);
        const approvalNonce = await withRpcRetry(() => transactionClient.getTransactionCount({
          address: creator,
          blockTag: "pending",
        }));
        const approvalHash = await writeContractAsync({
          address: ARC_ACTIVE_CONTRACTS.usdc,
          abi: erc20Abi,
          functionName: "approve",
          args: approvalArgs,
          gas: approvalGas,
          nonce: approvalNonce,
          ...approvalFees,
        });
        const approvalReceipt = await withRpcRetry(() => transactionClient.waitForTransactionReceipt({ hash: approvalHash }));
        if (approvalReceipt.status !== "success") throw new Error("Initial buy USDC approval reverted onchain.");
        setStatus("quoting_initial_buy");
        quote = await readInitialBuyQuote(transactionClient, launched.token, launched.pool, input);
      }

      const tradeArgs = [{
        tokenIn: ARC_ACTIVE_CONTRACTS.usdc,
        tokenOut: launched.token,
        fee: ARC_UNISWAP_V3.fee,
        recipient: creator,
        amountIn: quote.input,
        amountOutMinimum: quote.minimumOutput,
        sqrtPriceLimitX96: 0n,
      }] as const;
      const tradeGas = gasWithSafetyMargin(await withRpcRetry(() => transactionClient.estimateContractGas({
        account: creator,
        address: ARC_UNISWAP_V3.router,
        abi: uniswapV3RouterAbi,
        functionName: "exactInputSingle",
        args: tradeArgs,
      })));
      const tradeFees = await transactionFees(transactionClient);
      await ensureGasBalance(transactionClient, creator, tradeGas, tradeFees, input);
      const tradeNonce = await withRpcRetry(() => transactionClient.getTransactionCount({
        address: creator,
        blockTag: "pending",
      }));
      setStatus("buying_initial");
      buyHash = await writeContractAsync({
        address: ARC_UNISWAP_V3.router,
        abi: uniswapV3RouterAbi,
        functionName: "exactInputSingle",
        args: tradeArgs,
        gas: tradeGas,
        nonce: tradeNonce,
        ...tradeFees,
      });
    }

    const receipt = await withRpcRetry(() => transactionClient.waitForTransactionReceipt({ hash: buyHash }));
    if (receipt.status !== "success") throw new Error("The token launched, but the initial buy reverted onchain.");
    let tokensBought: bigint | undefined;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== launched.pool.toLowerCase()) continue;
      try {
        const event = decodeEventLog({
          abi: uniswapV3PoolAbi,
          eventName: "Swap",
          data: log.data,
          topics: log.topics,
        });
        const tokenIsToken0 = launched.token.toLowerCase() < ARC_ACTIVE_CONTRACTS.usdc.toLowerCase();
        const tokenDelta = tokenIsToken0 ? event.args.amount0 : event.args.amount1;
        tokensBought = tokenDelta < 0n ? -tokenDelta : tokenDelta;
        break;
      } catch {
        // Ignore non-Swap logs emitted by the pool transaction.
      }
    }
    if (tokensBought) {
      window.dispatchEvent(new CustomEvent("arcforge:trade-confirmed", {
        detail: {
          tokenAddress: launched.token,
          transactionHash: buyHash,
          side: "Buy",
          wallet: creator,
          blockNumber: receipt.blockNumber.toString(),
          timestamp: Math.floor(Date.now() / 1_000),
          usdc: Number(formatUnits(input, 6)),
          fee: Number(formatUnits(input * BigInt(ARC_UNISWAP_V3.fee) / 1_000_000n, 6)),
          tokens: Number(formatUnits(tokensBought, 18)),
        },
      }));
    }
    return { hash: buyHash, tokensBought };
  }

  async function launch() {
    if (!isConnected || !address) {
      setError("Connect your wallet in the header before launching a token.");
      return;
    }
    if (!publicClient) {
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
      const transactionClient = publicClient;
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
      const selectedInitialBuy = parseInitialBuyUsdc(form.initialBuyUsdc);
      if (selectedInitialBuy === null) {
        throw new Error("Initial buy must be between 0 and 100 USDC with no more than 6 decimal places.");
      }
      const requiredUsdc = currentLaunchFee + selectedInitialBuy;
      if (balance < requiredUsdc) {
        throw new Error(`You have ${formatUnits(balance, 6)} USDC, but the launch and selected initial buy require ${formatUnits(requiredUsdc, 6)} USDC before gas.`);
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
          automaticBuyback: form.automaticBuyback,
      };
      let launchHash: Hash;
      let safeSdk: SafeAppsSDK | undefined;
      if (safeLaunch) {
        const safeContext = await getSafeAppContext();
        if (!safeContext || safeContext.safe.safeAddress.toLowerCase() !== address.toLowerCase()) {
          throw new Error("Open ArcOrigin as a custom app inside the connected Safe and retry.");
        }
        safeSdk = safeContext.sdk;
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
          const approvalArgs = [ARC_ACTIVE_CONTRACTS.factory, currentLaunchFee] as const;
          const approvalGas = gasWithSafetyMargin(await withRpcRetry(() => transactionClient.estimateContractGas({
            account: address,
            address: ARC_ACTIVE_CONTRACTS.usdc,
            abi: erc20Abi,
            functionName: "approve",
            args: approvalArgs,
          })));
          const approvalFees = await transactionFees(transactionClient);
          await ensureGasBalance(transactionClient, address, approvalGas, approvalFees, currentLaunchFee);
          const approvalNonce = await withRpcRetry(() => transactionClient.getTransactionCount({
            address,
            blockTag: "pending",
          }));
          const approvalHash = await writeContractAsync({
            address: ARC_ACTIVE_CONTRACTS.usdc,
            abi: erc20Abi,
            functionName: "approve",
            args: approvalArgs,
            gas: approvalGas,
            nonce: approvalNonce,
            ...approvalFees,
          });
          const approvalReceipt = await withRpcRetry(() => transactionClient.waitForTransactionReceipt({ hash: approvalHash }));
          if (approvalReceipt.status !== "success") throw new Error("USDC approval reverted onchain.");
        }
        setStatus("launching");
        const launchArgs = [launchParameters] as const;
        const launchGas = gasWithSafetyMargin(await withRpcRetry(() => transactionClient.estimateContractGas({
          account: address,
          address: ARC_ACTIVE_CONTRACTS.factory,
          abi: factoryAbi,
          functionName: "launchToken",
          args: launchArgs,
        })));
        const launchFees = await transactionFees(transactionClient);
        await ensureGasBalance(transactionClient, address, launchGas, launchFees, currentLaunchFee);
        const launchNonce = await withRpcRetry(() => transactionClient.getTransactionCount({
          address,
          blockTag: "pending",
        }));
        launchHash = await writeContractAsync({
          address: ARC_ACTIVE_CONTRACTS.factory,
          abi: factoryAbi,
          functionName: "launchToken",
          args: launchArgs,
          gas: launchGas,
          nonce: launchNonce,
          ...launchFees,
        });
      }
      const receipt = await withRpcRetry(() => transactionClient.waitForTransactionReceipt({ hash: launchHash }));
      if (receipt.status !== "success") throw new Error("Token launch reverted onchain.");

      let launched: LaunchResult | null = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== ARC_ACTIVE_CONTRACTS.factory.toLowerCase()) continue;
        try {
          const event = decodeEventLog({ abi: factoryAbi, eventName: "TokenLaunched", data: log.data, topics: log.topics });
          launched = { token: event.args.token, pool: event.args.pool, hash: launchHash, metadataURI: metadata.metadataURI, metadataURL: metadata.gatewayURL };
          break;
        } catch {
          // The receipt includes constructor and registry logs from other contracts.
        }
      }
      if (!launched) throw new Error("The launch succeeded, but its TokenLaunched event was not found.");
      window.localStorage.setItem(
        `arcorigin:${arcChain.id}:last-launch-confirmed-at`,
        String(Date.now()),
      );
      window.dispatchEvent(new CustomEvent("arcforge:launch-confirmed", {
        detail: {
          tokenAddress: launched.token,
          poolAddress: launched.pool,
          transactionHash: launchHash,
        },
      }));
      void fetch("/api/onchain/tokens?refresh=1", { cache: "no-store" }).catch(() => undefined);
      let completedLaunch = launched;
      if (selectedInitialBuy > 0n) {
        try {
          const initialBuy = await executeInitialBuy(
            transactionClient,
            address,
            launched,
            selectedInitialBuy,
            safeSdk,
          );
          completedLaunch = {
            ...launched,
            initialBuyHash: initialBuy.hash,
            initialBuyUsdc: selectedInitialBuy,
            initialBuyTokens: initialBuy.tokensBought,
          };
        } catch (initialBuyError) {
          completedLaunch = {
            ...launched,
            initialBuyUsdc: selectedInitialBuy,
            initialBuyError: initialBuyErrorMessage(initialBuyError),
          };
        }
      }
      setResult(completedLaunch);
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
      <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-slate-400">Your metadata is pinned to public IPFS, and the fixed-supply token is live in its permanently locked Uniswap V3 pool on {arcChain.name}.{form.automaticBuyback ? " Automatic buyback and burn is permanently enabled." : ""}{result.initialBuyHash ? " The selected creator buy is also confirmed." : ""}</p>
      <dl className="mx-auto mt-6 grid max-w-lg gap-3 rounded-xl border border-line bg-black/25 p-4 text-left text-xs">
        <ResultRow label="Token" address={result.token} />
        <ResultRow label="Uniswap V3 pool" address={result.pool} />
        <ResultLink label="Metadata" href={result.metadataURL} value={result.metadataURI.slice(0, 22) + "…"} />
        <ResultLink label="Transaction" href={`${EXPLORER_URL}/tx/${result.hash}`} value={shortAddress(result.hash)} />
        {result.initialBuyHash && <>
          <ResultValue label="Creator buy" value={`${formatUnits(result.initialBuyUsdc ?? 0n, 6)} USDC`} />
          {result.initialBuyTokens !== undefined && <ResultValue
            label="Tokens received"
            value={Number(formatUnits(result.initialBuyTokens, 18)).toLocaleString("en-US", { maximumFractionDigits: 2 })}
          />}
          <ResultLink label="Buy transaction" href={`${EXPLORER_URL}/tx/${result.initialBuyHash}`} value={shortAddress(result.initialBuyHash)} />
        </>}
      </dl>
      {result.initialBuyError && <div className="mx-auto mt-4 max-w-lg text-left">
        <WarningBox>The token launch succeeded, but the optional initial buy was not executed: {result.initialBuyError} Open the token market to retry as a normal buy.</WarningBox>
      </div>}
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
              : status === "quoting_initial_buy"
                ? "Preparing initial buy…"
                : status === "approving_initial_buy"
                  ? `Approving ${initialBuyLabel}…`
                  : status === "buying_initial"
                    ? `Buying with ${initialBuyLabel}…`
                    : status === "safe_initial_buy"
                      ? "Confirm initial buy with Safe owners…"
                      : "Launch token";

  return <form onSubmit={submit} className="overflow-hidden rounded-3xl border border-line bg-panel shadow-glow lg:grid lg:grid-cols-[minmax(0,1fr)_380px]">
    <div className="p-5 sm:p-8 lg:p-10">
      <div className="mb-8">
        <h1 className="text-[34px] font-semibold tracking-[-.045em] text-white sm:text-[40px]">Launch token</h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-slate-400">Create a fixed-supply token directly in a permanently locked USDC Uniswap V3 pool.</p>
      </div>

      <div className="grid gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required value={form.name} onChange={(value) => update("name", value)} placeholder="Token name" maxLength={64} />
          <Field label="Ticker" required value={form.ticker} onChange={(value) => update("ticker", value.toUpperCase())} placeholder="SYMBOL" maxLength={10} />
        </div>

        <label htmlFor={descriptionId}>
          <span className="label">Description *</span>
          <textarea id={descriptionId} className="input min-h-28 resize-y py-3" required maxLength={TOKEN_DESCRIPTION_MAX_CHARACTERS} value={form.description} onChange={(event) => update("description", event.target.value)} placeholder="A short description of the token" />
          <span className="mt-1 block text-right text-[10px] text-slate-600">{form.description.length.toLocaleString("en-US")} / {TOKEN_DESCRIPTION_MAX_CHARACTERS.toLocaleString("en-US")}</span>
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

        <section className="rounded-2xl border border-line bg-black/15 p-4">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
            <div>
              <p className="text-sm font-semibold text-white">Initial creator buy <span className="font-normal text-slate-500">(optional)</span></p>
              <p className="mt-1 max-w-xl text-xs leading-5 text-slate-400">After the token is live, buy from its canonical Uniswap V3 pool with the creator wallet. This is a separate protected transaction and appears transparently as a creator buy.</p>
            </div>
            <label className="shrink-0 sm:w-40">
              <span className="sr-only">Initial creator buy in USDC</span>
              <span className="relative block">
                <input
                  className="input pr-14 text-right font-mono"
                  inputMode="decimal"
                  placeholder="0"
                  value={form.initialBuyUsdc}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value.length <= 10 && /^\d*(?:\.\d{0,6})?$/.test(value)) {
                      setForm((current) => ({ ...current, initialBuyUsdc: value }));
                    }
                  }}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-medium text-slate-500">USDC</span>
              </span>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setForm((current) => ({ ...current, initialBuyUsdc: "" }))}
              className={`rounded-lg border px-3 py-1.5 text-xs transition ${!form.initialBuyUsdc ? "border-cyan/35 bg-cyan/[.08] text-cyan" : "border-line text-slate-400 hover:border-cyan/25 hover:text-white"}`}
            >None</button>
            {INITIAL_BUY_PRESETS.map((amount) => <button
              key={amount}
              type="button"
              onClick={() => setForm((current) => ({ ...current, initialBuyUsdc: String(amount) }))}
              className={`rounded-lg border px-3 py-1.5 text-xs transition ${form.initialBuyUsdc === String(amount) ? "border-cyan/35 bg-cyan/[.08] text-cyan" : "border-line text-slate-400 hover:border-cyan/25 hover:text-white"}`}
            >{amount}</button>)}
          </div>
          {!initialBuyValid && <p className="mt-2 text-[11px] text-rose-300">Enter an amount from 0 to 100 USDC with no more than 6 decimal places.</p>}
          <p className="mt-3 text-[11px] leading-5 text-slate-500">Maximum 100 USDC · 10% minimum-output protection · rejecting or failing this optional buy does not reverse the token launch.</p>
        </section>

        <label className={`flex cursor-pointer gap-4 rounded-2xl border p-4 transition ${form.automaticBuyback ? "border-cyan/35 bg-cyan/[.06]" : "border-line bg-black/15 hover:border-cyan/20"}`}>
          <input
            type="checkbox"
            checked={form.automaticBuyback}
            onChange={(event) => setForm((current) => ({ ...current, automaticBuyback: event.target.checked }))}
            className="mt-1 size-4 shrink-0 accent-cyan"
          />
          <span>
            <span className="block text-sm font-semibold text-white">Automatic buyback and burn</span>
            <span className="mt-1 block text-xs leading-5 text-slate-400">
              Permanently redirect the creator&apos;s 70% LP-fee share to buy this token with USDC and burn it. Token-denominated fees burn immediately. A permissionless keeper may execute protected batches and earns up to 0.5% of spent USDC, capped at 1 USDC.
            </span>
            <span className="mt-2 block text-[11px] font-medium text-amber-200">Irreversible after launch. The creator will not receive this fee share.</span>
          </span>
        </label>

        <div className="grid overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3">
          <PaymentSummary label="Launch fee" value={launchFeeLabel} />
          <PaymentSummary label="Initial creator buy" value={initialBuyLabel} />
          <PaymentSummary label="Initial market cap" value="5,000 USDC" />
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
            <Row label="Initial creator buy" value={initialBuyLabel} />
            <Row label="Trading fee" value={form.automaticBuyback ? "1% · 70% buyback / 30% protocol" : "1% · 70% creator / 30% protocol"} />
            <Row label="Auto buyback" value={form.automaticBuyback ? "Enabled forever" : "Off"} />
            <Row label="Crossed mark" value={`${formatDisplayNumber(ARCORIGIN_CROSS_MARKET_CAP_USDC)} USDC`} />
            <Row label="LP custody" value="Locked forever" />
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

function ResultValue({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-4"><dt className="text-slate-500">{label}</dt><dd className="text-right text-slate-200">{value}</dd></div>;
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
