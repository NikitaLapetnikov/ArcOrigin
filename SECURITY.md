# ArcOrigin security

## Scope

The current protocol consists of `ArcForgeFactory`, `ArcForgeToken`, `ArcForgeFeeVault`, `ArcForgeCreatorRegistry`, `ArcOriginUniswapV3LiquidityLocker`, and the minimal Uniswap interfaces and math library they use.

The product indexes only launches emitted by the configured active Factory. Previous deployments and their tokens are outside the current application scope.

## Core invariants

- Each launch creates an initial one-billion-token supply with no owner, mint, tax, blacklist, or token pause. No account can burn another holder's balance.
- The canonical token/USDC Uniswap V3 pool and its single-sided position are created in the launch transaction.
- The LP NFT is owned by an immutable locker with no transfer, withdrawal, or liquidity-decrease path.
- The 50,000 USDC Crossed mark changes status only; it cannot move liquidity or alter trading.
- Pool verification checks both Factory launch data and the canonical Uniswap Factory before quoting.
- Ordinary LP positions distribute 70% of collected fees to the recorded creator and 30% to the protocol Fee Vault.
- Automatic buyback is an immutable per-position launch choice. It redirects the creator's 70% share: launch-token fees burn immediately and USDC fees enter that position's buyback reserve. The protocol share remains 30%.
- Buyback execution is permissionless and constrained to the position's canonical pool and the immutable official Router. It requires at least 1 USDC, a 15-minute cooldown, a 15-minute TWAP within 600 ticks of spot, and a bounded sqrt-price limit. The executor receives 0.5% of USDC actually spent, capped at 1 USDC.
- The Factory starts paused. Only governance can unpause; the emergency guardian may pause future launches but cannot move assets.
- Ownership renunciation is disabled on protocol administration contracts.

## Operational controls

Mainnet candidates must remain paused until all of the following are complete:

1. Independent review of the exact source and compiler settings.
2. Reproducible creation-bytecode verification against the published source commit and exact constructor arguments. Arc mainnet explorer source verification is currently unavailable.
3. A fork or testnet launch covering both token orderings and live Router trades.
4. Verification that the Governance Safe is exactly the intended 2-of-3 owner.
5. Coordinated application and indexer configuration using the new Factory address and deployment block.
6. Health monitoring, RPC failover, Redis persistence, and reorg recovery checks.

The current internal review and its limitations are recorded in `audit/SECURITY_REVIEW.md`.

Never store deployer keys, Safe signer material, RPC credentials, Pinata tokens, or Redis credentials in the repository. Deployment scripts produce a paused candidate and unsigned Safe operations; they do not authorize automatic activation.

The buyback keeper key has no protocol privileges and must be separate from deployer and Safe signers. Keeper availability is not guaranteed: any account can execute an eligible buyback if the platform keeper is offline. Failed eligibility checks revert atomically, including fee collection attempted in the same call.

## Known risks

Permanent LP custody does not guarantee demand, token quality, price stability, or sufficient depth. A token can lose all value. Smart-contract defects, compromised wallets, RPC failures, Uniswap failures, metadata gateway outages, and malicious token creators remain possible.

Quotes are not reservations. Slippage limits protect minimum output, but transactions can still fail or be reordered. Users must verify token and pool addresses before signing.

Buybacks are market orders within explicit limits, not price guarantees. MEV, pool volatility, insufficient TWAP history, low reserves, RPC outages, or an unfunded keeper can delay execution. Enabling buyback is irreversible and permanently forfeits the creator's 70% fee payout for that position.

## Reporting

Do not disclose an active vulnerability publicly. Send a minimal reproduction, affected commit, impact, and suggested mitigation to the project owner through a private channel. Avoid moving user funds or testing against production assets without explicit authorization.
