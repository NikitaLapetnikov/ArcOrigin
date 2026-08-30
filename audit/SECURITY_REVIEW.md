# ArcOrigin security review

Review date: 2026-08-30

This is an internal engineering security review of the source committed with this report. It is not a substitute for an independent third-party audit.

## Scope

- `ArcForgeFactory`
- `ArcForgeToken`
- `ArcForgeFeeVault`
- `ArcForgeCreatorRegistry`
- `ArcOriginUniswapV3LiquidityLocker`
- `ArcOriginUniswapV3Math`
- minimal Uniswap interfaces
- opt-in automatic buyback/burn accounting and keeper incentives
- permissionless VPS keeper and systemd timer
- launch UI ABI and irreversible opt-in disclosure
- Arc mainnet deployment, Safe activation, and post-deployment verification scripts

## Result

No unresolved critical or high-severity issue was found in the reviewed contracts. The source may be deployed only as a paused mainnet candidate. Activation remains gated by a successful updated Arc mainnet fork run, reproducible creation-bytecode verification, candidate-state verification, Safe review and signatures, keeper setup, and the production UI/indexer cutover.

## Remediated findings

### Stale shared-contract authority during Factory rotation

Severity: medium

The initial activation operations authorized the new Factory but did not pause the previous Factory or revoke its FeeVault registrar and collector roles. The Safe batch now performs the retirement and ACL rotation atomically before selecting and unpausing the new Factory.

### Obsolete protocol fee recipient

Severity: medium

The live FeeVault recipient still pointed to the retired buyback controller. The Safe batch now changes the recipient to the explicitly reviewed protocol Safe before the new Factory is activated.

### Private RPC disclosure in network verification output

Severity: low

The network verifier printed its full RPC URL. Authenticated endpoints may contain credentials. Output now reports only whether a configured endpoint or public fallback was used.

### Safe owner validation was count-only

Severity: low

Deployment checked for a unique 2-of-3 Safe but did not compare the exact reviewed owners. Preflight and post-deployment verification now require the exact three-owner set.

### Manifest recovery after an RPC interruption

Severity: low

The deployment transaction could succeed while a later verification read failed before the local manifest was written. A recovery command now reconstructs the manifest and Safe batch from the confirmed creation receipt, verifies the complete candidate state with bounded retries, and never resubmits deployment.

### Unbounded automatic buyback execution

Severity: high before mitigation

A naive permissionless market buyback could be sandwiched or executed against a manipulated spot price. The implemented path uses the immutable official Router and registered canonical pool, a 15-minute TWAP, a maximum 600-tick spot/TWAP deviation, a 2% sqrt-price movement limit, a 15-minute cooldown, and exact token balance-delta checks. A non-zero price limit permits safe partial input rather than forcing the entire reserve through insufficient depth.

### Keeper custody or administrative authority

Severity: medium before mitigation

The keeper is permissionless and owns no protocol role. Its one-shot job first simulates the complete collect-and-buyback call, submits only an eligible transaction, and can be replaced by any caller. Its dedicated key must not be a deployer or Safe owner. Contract eligibility checks, not the VPS, decide whether execution is allowed.

### Cross-position reserve accounting

Severity: medium before mitigation

USDC reserves are isolated by position ID. Swap spend and output use before/after balance deltas, the Router allowance is bounded to the current swap budget and cleared afterward, and reserve reduction uses actual USDC spent plus the bounded reward. Ordinary positions retain the previous 70/30 payout behavior.

## Contract analysis

Slither 0.11.6 analyzed the clean build (36 contracts, 102 detectors). With dependencies and mocks filtered, it reported 24 items; each was reviewed:

- Four high-confidence `reentrancy-balance` and two medium `reentrancy-no-eth` reports identify the intentional balance-delta checks around the official PositionManager and Router. All state-changing public collection and buyback entry points are `nonReentrant`; the immutable launch tokens are standard ArcOrigin ERC-20s, and the deployment pins addresses whose bytecode is checked by the separate mainnet dependency verifier. No callback can enter another state-changing locker path.
- Tick division followed by multiplication is intentional tick-spacing alignment.
- Strict zero/equality checks intentionally reject non-single-sided liquidity and any mismatch between reported and observed token movements.
- Ignored tuple fields are unused canonical Uniswap return values.
- Timestamp use covers the mint deadline and the buyback cooldown. A block producer can shift execution time slightly but cannot bypass the TWAP, minimum reserve, price limit, or permission checks.

Factory runtime bytecode is 19,064 bytes, below the EIP-170 limit. Constructor bytecode is 32,960 bytes, below the EIP-3860 limit. LiquidityLocker runtime bytecode is 11,302 bytes.

## Tests and live checks

- Unit suite: 10 passing cases covering initial supply, atomic pool creation, LP custody, ordinary fee split, opt-in reserve routing, immediate token-fee burn, true buyback supply burn, minimum/capped keeper economics, manipulated-price rejection, both token address orderings, crossed status, pool-poison retry, and guardian controls.
- Arc mainnet fork suite now covers canonical Uniswap Factory, PositionManager, Quoter, and Router; launch, buy, sell, LP ownership, fee collection, TWAP-backed buyback, keeper reward, and supply burn for both token address orderings. The updated fork case must pass against the production RPC before candidate deployment.
- Arc USDC uses a chain-native precompile that Hardhat cannot emulate. The fork test substitutes standard six-decimal ERC-20 runtime at the canonical address only inside the fork. Live verification separately checks the real USDC bytecode hash, decimals, and symbol.
- Live dependency verification at block 18,259,815 confirmed the expected bytecode hashes for Arc USDC and all configured Uniswap contracts, with the 1% fee tier enabled at tick spacing 200.
- Live governance inspection confirmed the configured 2-of-3 Safe owns the previous Factory, FeeVault, and CreatorRegistry.
- Arcscan documents that mainnet source verification is currently unavailable because Sourcify does not support chain 5042. Deployment verification therefore compares the complete creation transaction input byte-for-byte with the audited compiler output and exact constructor arguments, then separately verifies runtime configuration. See https://docs.arc-scan.org/docs/addresses.

## Residual risks

- Uniswap spot price can be manipulated. It affects only the informational Crossed status and does not release or move assets.
- A buyback is a bounded market order, not a guaranteed execution price. It can be delayed by TWAP deviation, insufficient observation history, low reserves, RPC failure, keeper funding, or transaction competition. Manipulation that remains inside configured TWAP and price limits may still extract some value.
- Automatic buyback is irreversible for a launch. The creator permanently gives up its 70% LP-fee payout, and a bug cannot be repaired by changing that position's mode.
- A predicted pool can be initialized first and revert one launch attempt. Parent-block-bound token salts allow retrying in the next block.
- LP custody is permanent by design. A bug or incorrect market configuration cannot be repaired by withdrawing principal.
- Availability depends on Arc, Uniswap, RPC, explorer, Redis, and metadata infrastructure.
- Safe security depends on protecting at least two owners and carefully reviewing the final batch calldata.

## Deployment decision

Deploy only a paused candidate owned directly by the reviewed Governance Safe. Do not execute the activation batch unless the updated mainnet fork, reproducible creation-bytecode verification, candidate-mode verification, production build, UI cutover, and keeper dry run all pass. The activation batch must be executed atomically through the Governance Safe and followed by active-mode verification.
