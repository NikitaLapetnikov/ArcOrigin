# AORG protocol token and buyback runbook

Status: implementation and testnet preparation. No AORG address or buyback controller is
canonical until the Safe launch and the deployment record are completed and independently reviewed.

## Canonical token

| Parameter | Value |
| --- | --- |
| Name | ArcOrigin |
| Symbol | AORG |
| Supply | 1,000,000,000 fixed |
| Free creator allocation | 0 |
| Quote asset | Arc USDC |
| Curve target | 10,000 USDC |
| Buy / sell fee | 1% / 1% |
| Creator / protocol split | 70% / 30% |

AORG must be launched through the active V6 Factory by the 2-of-3 ArcOrigin Safe. V6 stores
the launch caller as the immutable creator fee recipient. Launching from a personal EOA would
permanently bind the 70% creator share to that EOA and is therefore prohibited.

The AORG launch must snapshot a disabled migration configuration. This keeps its canonical
V6 curve available to the buyback controller permanently. The controller constructor and
deployment preflight both reject a migration-enabled or mismatched curve.

## Revenue policy

Each amount of USDC transferred from the FeeVault to the controller is permissionlessly
allocated using an immutable split:

- 80% becomes `pendingBuybackUsdc` and can only be spent buying canonical AORG;
- 20% is transferred to the configured operations Safe;
- bought AORG is immediately sent to `0x000000000000000000000000000000000000dEaD`.

Sending tokens to the burn address reduces circulating supply, not the ERC-20 `totalSupply()`
return value. Interfaces must label these values separately and derive burned supply from the
burn address balance plus controller events.

Buyback and burning do not guarantee price appreciation, liquidity, or investment returns.

## TWAP safety boundaries

`ArcOriginBuybackController` enforces all of the following onchain:

1. only a timelock owner or authorized executor may execute a slice;
2. a slice cannot exceed 1% of the curve's immutable virtual USDC reserve;
3. executions are separated by at least five minutes;
4. transaction deadlines cannot extend beyond fifteen minutes;
5. minimum output cannot accept more than 5% slippage;
6. AORG output can only reach the canonical burn address;
7. pending buyback USDC and AORG cannot be recovered by governance;
8. the emergency guardian can pause but cannot resume, reconfigure, withdraw, or trade;
9. governance changes use `Ownable2Step`, and ownership renunciation is disabled.

Recommended initial Testnet configuration:

- maximum slice: 25 USDC;
- interval: 3,600 seconds;
- maximum slippage: 300 bps;
- owner: the 48-hour governance timelock;
- operations recipient and guardian: the reviewed 2-of-3 Safe;
- executor: a dedicated automation account with no withdrawal authority.

## Launch sequence

1. Upload the final logo and metadata and record the immutable IPFS URI.
2. Open `https://arcorigin.xyz` as a custom Safe App, then connect the ArcOrigin
   2-of-3 Safe. ArcOrigin supports Safe Apps signing and verifies metadata
   authorization through ERC-1271 on Arc Testnet.
3. Confirm Factory `0xD342C9d0651Be1138E7cab53C7F38ea02eD61c6d`, symbol `AORG`,
   zero free allocation, current 10 USDC fee, and 10,000 USDC target.
4. Approve exactly the required launch payment and execute `launchToken` from the Safe.
5. Record the emitted token and curve addresses and verify them against `getTokenInfo`.
6. Run the buyback deployment preflight:

   ```bash
   AORG_TOKEN=0x... \
   AORG_CURVE=0x... \
   BUYBACK_OWNER=0xTimelock \
   BUYBACK_GUARDIAN=0xSafe \
   BUYBACK_OPERATIONS_RECIPIENT=0xSafe \
   BUYBACK_EXECUTOR=0xDedicatedExecutor \
   DEPLOY_PREFLIGHT_ONLY=true \
   pnpm deploy:arc-testnet:aorg-buyback
   ```

7. Review the preflight output, tests, runtime bytecode, token metadata, Safe policy, and
   executor operational security.
8. Remove `DEPLOY_PREFLIGHT_ONLY`, deploy once, and preserve the generated local deployment record.
9. Schedule the generated `FeeVault.setFeeRecipient(controller)` calldata through the governance
   Safe and 48-hour timelock. Do not call the FeeVault directly after governance handoff.
10. Execute one small withdrawal, allocation, and 25 USDC buyback; verify the operations transfer,
    AORG burn balance, controller accounting, and emitted events before enabling automation.

## Automation

The executor should obtain a fresh onchain `quoteBuy`, submit a minimum output within the
configured slippage bound, and use a deadline no more than ten minutes ahead. It should wait
for finality, reconcile the `BuybackExecuted` event, and alert on reverts or accounting drift.

Never store the executor key, Safe signer keys, RPC credentials, or private API keys in the
repository. Compromise of the executor cannot redirect funds, but it can choose execution timing
within the configured TWAP bounds; pause it immediately if its key is suspected.
