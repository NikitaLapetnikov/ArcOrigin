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
- Arc mainnet deployment, Safe activation, and post-deployment verification scripts

## Result

No unresolved critical or high-severity issue was found in the reviewed contracts. The source is approved for deployment as a paused mainnet candidate. Activation remains gated by reproducible creation-bytecode verification, candidate-state verification, Safe review and signatures, and the production UI/indexer cutover.

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

## Contract analysis

Slither analyzed 34 compiled contracts with 102 detectors. Reported items were reviewed as follows:

- Reentrancy reports are mitigated by `nonReentrant` on both launch and fee-collection entry points.
- Tick division followed by multiplication is intentional tick-spacing alignment.
- Strict zero/equality checks enforce single-sided liquidity and exact accounting invariants.
- Ignored tuple fields are unused canonical Uniswap return values.
- Timestamp use is limited to the mint deadline and launch metadata; it does not decide asset transfers or privileges.

Factory runtime bytecode is 18,191 bytes, below the EIP-170 limit. Constructor bytecode is 26,219 bytes, below the EIP-3860 limit.

## Tests and live checks

- Unit suite: fixed supply, atomic pool creation, LP custody, fee split, crossed status, pool-poison retry, and guardian controls.
- Arc mainnet fork: canonical Uniswap Factory, PositionManager, Quoter, and Router; successful launch, buy, sell, LP ownership, and fee collection for both token address orderings.
- Arc USDC uses a chain-native precompile that Hardhat cannot emulate. The fork test substitutes standard six-decimal ERC-20 runtime at the canonical address only inside the fork. Live verification separately checks the real USDC bytecode hash, decimals, and symbol.
- Live dependency verification at block 18,259,815 confirmed the expected bytecode hashes for Arc USDC and all configured Uniswap contracts, with the 1% fee tier enabled at tick spacing 200.
- Live governance inspection confirmed the configured 2-of-3 Safe owns the previous Factory, FeeVault, and CreatorRegistry.
- Arcscan documents that mainnet source verification is currently unavailable because Sourcify does not support chain 5042. Deployment verification therefore compares the complete creation transaction input byte-for-byte with the audited compiler output and exact constructor arguments, then separately verifies runtime configuration. See https://docs.arc-scan.org/docs/addresses.

## Residual risks

- Uniswap spot price can be manipulated. It affects only the informational Crossed status and does not release or move assets.
- A predicted pool can be initialized first and revert one launch attempt. Parent-block-bound token salts allow retrying in the next block.
- LP custody is permanent by design. A bug or incorrect market configuration cannot be repaired by withdrawing principal.
- Availability depends on Arc, Uniswap, RPC, explorer, Redis, and metadata infrastructure.
- Safe security depends on protecting at least two owners and carefully reviewing the final batch calldata.

## Deployment decision

Deploy only a paused candidate owned directly by the reviewed Governance Safe. Do not execute the activation batch unless reproducible creation-bytecode verification and candidate-mode verification both pass. The activation batch must be executed atomically through the Governance Safe and followed by active-mode verification.
