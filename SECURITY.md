# ArcOrigin security

## Scope

The current protocol consists of `ArcForgeFactory`, `ArcForgeToken`, `ArcForgeFeeVault`, `ArcForgeCreatorRegistry`, `ArcOriginUniswapV3LiquidityLocker`, and the minimal Uniswap interfaces and math library they use.

The product indexes only launches emitted by the configured active Factory. Previous deployments and their tokens are outside the current application scope.

## Core invariants

- Each launch creates a fixed one-billion-token supply with no owner, mint, tax, blacklist, or token pause.
- The canonical token/USDC Uniswap V3 pool and its single-sided position are created in the launch transaction.
- The LP NFT is owned by an immutable locker with no transfer, withdrawal, or liquidity-decrease path.
- The 50,000 USDC Crossed mark changes status only; it cannot move liquidity or alter trading.
- Pool verification checks both Factory launch data and the canonical Uniswap Factory before quoting.
- LP fees are distributed 70% to the recorded creator and 30% to the protocol Fee Vault. Fee collection is permissionless, but recipients are immutable per position.
- The Factory starts paused. Only governance can unpause; the emergency guardian may pause future launches but cannot move assets.
- Ownership renunciation is disabled on protocol administration contracts.

## Operational controls

Mainnet candidates must remain paused until all of the following are complete:

1. Independent review of the exact source and compiler settings.
2. Source verification for every deployed contract.
3. A fork or testnet launch covering both token orderings and live Router trades.
4. Verification that the Governance Safe is exactly the intended 2-of-3 owner.
5. Coordinated application and indexer configuration using the new Factory address and deployment block.
6. Health monitoring, RPC failover, Redis persistence, and reorg recovery checks.

The current internal review and its limitations are recorded in `audit/SECURITY_REVIEW.md`.

Never store deployer keys, Safe signer material, RPC credentials, Pinata tokens, or Redis credentials in the repository. Deployment scripts produce a paused candidate and unsigned Safe operations; they do not authorize automatic activation.

## Known risks

Permanent LP custody does not guarantee demand, token quality, price stability, or sufficient depth. A token can lose all value. Smart-contract defects, compromised wallets, RPC failures, Uniswap failures, metadata gateway outages, and malicious token creators remain possible.

Quotes are not reservations. Slippage limits protect minimum output, but transactions can still fail or be reordered. Users must verify token and pool addresses before signing.

## Reporting

Do not disclose an active vulnerability publicly. Send a minimal reproduction, affected commit, impact, and suggested mitigation to the project owner through a private channel. Avoid moving user funds or testing against production assets without explicit authorization.
