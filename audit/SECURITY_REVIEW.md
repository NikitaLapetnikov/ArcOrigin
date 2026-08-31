# ArcOrigin security review

Review date: 2026-08-31

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
- production web application, API routes, RPC failover, persistent snapshots, CSP, and request limits
- wallet transaction preparation, polling, upload boundaries, dependency advisories, and VPS operations

## Result

No unresolved critical or high-severity issue was found in the reviewed contracts or application paths. The reviewed candidate was activated through the Governance Safe after reproducible bytecode and runtime checks. The production health probe confirms the Safe remains the Factory owner, launches are enabled, the Factory has bytecode, Redis is reachable, and the index checkpoint is canonical.

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

### RPC load amplification and stale browser endpoints

Severity: high availability impact before mitigation

Background browser polling forced market, holder, launch, latest-buy, and buyback requests to bypass the shared server cache. Browser CSP also retained the retired Blockdaemon endpoint while omitting active failover providers. Background refreshes now use bounded stale-while-revalidate snapshots, explicit user refresh and post-trade reconciliation remain immediate, and CSP is generated from the configured mainnet providers. Shared RPC error detection includes Arc's `-32005` capacity response.

### Transaction submission depended on wallet RPC reads

Severity: high availability impact before mitigation

Wallet-provided RPC clients could return the retired Blockdaemon 401 response or capacity errors while preparing a valid trade or launch. Reads, simulations, gas estimation, pending nonce selection, and fee estimation now use the application's failover client. The wallet receives a fully prepared transaction only for signing and submission. Pool and Router identities returned by the quote path are revalidated before use.

### Native-USDC gas balance double counting

Severity: medium

Arc's native gas balance and canonical six-decimal USDC precompile represent the same funds at different precision. Independent checks could accept an account that had enough for the amount and enough for gas separately but not enough for both together. Buy, approval, and launch preparation now converts quote USDC into native precision and requires the combined amount plus maximum gas before requesting a signature.

### Unbounded public quote work

Severity: medium

The quote endpoint accepted unlimited concurrent unique simulations. It now validates canonical Factory and Uniswap pool membership, limits per-client requests, caps concurrent unique quotes, deduplicates identical pending work, and bounds its short-lived cache.

### Metadata size and dependency exposure

Severity: medium

Descriptions had no explicit character ceiling, and externally resolved metadata could exceed UI-safe limits. Both signed upload input and resolved external metadata are capped and control characters are rejected. Production dependency scanning identified vulnerable transitive `hono`, `nanoid`, and `postcss` versions; workspace overrides and the lockfile now resolve patched releases. The production-only advisory scan reports zero known vulnerabilities.

### Keeper single-endpoint dependency

Severity: medium availability impact

The permissionless keeper used only the primary RPC and failed when that provider returned Arc's capacity limit. Its public and wallet clients now share an ordered multi-provider failover transport populated from production fallback configuration. No keeper credential or administrative authority is exposed to the application.

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
- Arc mainnet fork suite passed against the production RPC in 99.251 seconds with exit status 0. It covered canonical Uniswap Factory, PositionManager, Quoter, and Router; launch, buy, sell, LP ownership, fee collection, a 15-minute TWAP-backed buyback, keeper reward, and supply burn for both token address orderings.
- Arc USDC uses a chain-native precompile that Hardhat cannot emulate. The fork test substitutes standard six-decimal ERC-20 runtime at the canonical address only inside the fork. Live verification separately checks the real USDC bytecode hash, decimals, and symbol.
- Live dependency verification at block 18,259,815 confirmed the expected bytecode hashes for Arc USDC and all configured Uniswap contracts, with the 1% fee tier enabled at tick spacing 200.
- Live governance inspection confirmed the configured 2-of-3 Safe owns the previous Factory, FeeVault, and CreatorRegistry.
- Arcscan documents that mainnet source verification is currently unavailable because Sourcify does not support chain 5042. Deployment verification therefore compares the complete creation transaction input byte-for-byte with the audited compiler output and exact constructor arguments, then separately verifies runtime configuration. See https://docs.arc-scan.org/docs/addresses.
- Application lint, strict TypeScript checking, production build, contract tests, indexer resilience tests, and production health tests pass on the reviewed source.
- Production dependency audit reports zero known production vulnerabilities after patched transitive overrides.
- Desktop and mobile smoke checks covered the home, launch, profile, token terminal, light/dark themes, timeframe controls, chart tools, and responsive overflow without submitting a wallet transaction.
- The live main-domain health endpoint reported `ok`, Safe ownership matched, launches were enabled, Redis was reachable, and the index checkpoint was canonical during the review.

## Residual risks

- Uniswap spot price can be manipulated. It affects only the informational Crossed status and does not release or move assets.
- A buyback is a bounded market order, not a guaranteed execution price. It can be delayed by TWAP deviation, insufficient observation history, low reserves, RPC failure, keeper funding, or transaction competition. Manipulation that remains inside configured TWAP and price limits may still extract some value.
- Automatic buyback is irreversible for a launch. The creator permanently gives up its 70% LP-fee payout, and a bug cannot be repaired by changing that position's mode.
- A predicted pool can be initialized first and revert one launch attempt. Parent-block-bound token salts allow retrying in the next block.
- LP custody is permanent by design. A bug or incorrect market configuration cannot be repaired by withdrawing principal.
- Availability depends on Arc, Uniswap, RPC, explorer, Redis, and metadata infrastructure.
- Safe security depends on protecting at least two owners and carefully reviewing the final batch calldata.

## Deployment status

The reviewed deployment is active on Arc mainnet and owned directly by the reviewed Governance Safe. Future contract changes must repeat the paused-candidate, reproducible-bytecode, fork-test, Safe-batch, and post-activation verification process. Application-only releases must continue to pass the complete local suite, dependency audit, atomic VPS activation, public health check, and browser smoke test.
