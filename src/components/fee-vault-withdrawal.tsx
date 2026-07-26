"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, LoaderCircle, WalletCards } from "lucide-react";
import { formatUnits, type Address, type Hash } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { ARC_TESTNET_CONTRACTS, EXPLORER_URL, arcTestnet } from "@/lib/chains";
import { erc20Abi } from "@/lib/contracts";
import { Button, WarningBox } from "@/components/ui";
import { shortAddress } from "@/lib/utils";

const feeVaultAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "feeRecipient", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;

type VaultState = {
  balance: bigint;
  owner: Address;
  recipient: Address;
};

export function FeeVaultWithdrawal() {
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const [vault, setVault] = useState<VaultState | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [hash, setHash] = useState<Hash | null>(null);

  const refresh = useCallback(async () => {
    if (!publicClient) return;
    setLoading(true);
    setError("");
    try {
      const [balance, owner, recipient] = await Promise.all([
        publicClient.readContract({
          address: ARC_TESTNET_CONTRACTS.usdc,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [ARC_TESTNET_CONTRACTS.feeVault],
        }),
        publicClient.readContract({
          address: ARC_TESTNET_CONTRACTS.feeVault,
          abi: feeVaultAbi,
          functionName: "owner",
        }),
        publicClient.readContract({
          address: ARC_TESTNET_CONTRACTS.feeVault,
          abi: feeVaultAbi,
          functionName: "feeRecipient",
        }),
      ]);
      setVault({ balance, owner, recipient });
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : "Could not read the Fee Vault.");
    } finally {
      setLoading(false);
    }
  }, [publicClient]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const authorized = Boolean(
    address && vault &&
    (address.toLowerCase() === vault.owner.toLowerCase() ||
      address.toLowerCase() === vault.recipient.toLowerCase()),
  );

  async function withdrawAll() {
    if (!publicClient || !vault || vault.balance === 0n || !address) return;
    setSubmitting(true);
    setError("");
    setHash(null);
    try {
      if (chainId !== arcTestnet.id) await switchChainAsync({ chainId: arcTestnet.id });
      if (!authorized) throw new Error("The connected wallet is not the Vault owner or fee recipient.");
      const transactionHash = await writeContractAsync({
        address: ARC_TESTNET_CONTRACTS.feeVault,
        abi: feeVaultAbi,
        functionName: "withdraw",
        args: [ARC_TESTNET_CONTRACTS.usdc, vault.balance],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
      if (receipt.status !== "success") throw new Error("The withdrawal reverted onchain.");
      setHash(transactionHash);
      await refresh();
    } catch (withdrawError) {
      const message = withdrawError instanceof Error ? withdrawError.message : "Withdrawal failed.";
      setError(/rejected|denied/i.test(message) ? "The wallet request was cancelled." : message);
    } finally {
      setSubmitting(false);
    }
  }

  return <section className="mt-5 max-w-3xl overflow-hidden rounded-2xl border border-line bg-panel">
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line p-5 md:p-6">
      <div>
        <p className="eyebrow">Fee Vault</p>
        <h2 className="mt-2 text-xl font-semibold text-white">Withdraw protocol USDC</h2>
      </div>
      <div className="text-right">
        <p className="font-mono text-[9px] uppercase tracking-[.12em] text-slate-600">Available</p>
        <p className="mt-1 text-2xl font-semibold text-white">
          {loading || !vault ? "—" : `${Number(formatUnits(vault.balance, 6)).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC`}
        </p>
      </div>
    </div>
    <div className="grid gap-5 p-5 md:p-6">
      <dl className="grid gap-3 text-sm">
        <div className="flex items-center justify-between gap-4">
          <dt className="text-slate-500">Connected wallet</dt>
          <dd className="font-mono text-xs text-slate-300">{address ? shortAddress(address) : "Not connected"}</dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-slate-500">Fixed recipient</dt>
          <dd className="font-mono text-xs text-slate-300">{vault ? shortAddress(vault.recipient) : "—"}</dd>
        </div>
      </dl>
      {!isConnected && <WarningBox>Connect the Vault owner wallet in the header. No seed phrase or private key is required.</WarningBox>}
      {isConnected && vault && !authorized && <WarningBox>The connected wallet is not authorized to withdraw this Vault.</WarningBox>}
      {error && <p className="rounded-xl border border-red-400/20 bg-red-400/[.06] p-3 text-sm text-red-200">{error}</p>}
      {hash && <a href={`${EXPLORER_URL}/tx/${hash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm font-medium text-cyan">
        Withdrawal confirmed · {shortAddress(hash)} <ExternalLink className="size-4" />
      </a>}
      <Button
        type="button"
        className="w-full sm:w-fit"
        disabled={!isConnected || !authorized || !vault || vault.balance === 0n || submitting}
        onClick={() => void withdrawAll()}
      >
        {submitting ? <><LoaderCircle className="size-4 animate-spin" /> Confirming withdrawal…</> : <><WalletCards className="size-4" /> Withdraw full balance</>}
      </Button>
      <p className="text-xs leading-5 text-slate-500">
        The contract always sends funds to its current fee recipient. This action cannot redirect the withdrawal to another address.
      </p>
    </div>
  </section>;
}
