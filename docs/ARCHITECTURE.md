# ArcOrigin architecture

ArcOrigin launches every token directly into a canonical Uniswap V3 pool. There is no separate bonding curve and no migration lifecycle.

## Launch transaction

Each successful launch is atomic:

1. Deploy a fixed-supply ERC-20 with 1 billion tokens and no owner, mint, tax, pause, or blacklist hooks.
2. Create or initialize the canonical token/USDC Uniswap V3 pool at a $5,000 starting market cap using the official 1% fee tier.
3. Mint a single-sided LP position with the launch token supply.
4. Send the LP NFT directly to the immutable liquidity locker.
5. Burn any token dust caused by Uniswap rounding, so the LP principal equals the effective total supply.
6. Emit `TokenLaunched(token, pool, creator, name, symbol, positionId)`.

Token deployment uses a parent-block-bound `CREATE2` salt. A searcher can still make one launch transaction revert by front-running an initialization for its predicted pool, but the next block derives a different token address; a poisoned pool cannot permanently brick the Factory nonce.

The locker has no NFT transfer, approval, liquidity decrease, burn, rescue, or administrative mutation function. Anyone can collect accrued LP fees; the locker sends 70% to the creator and 30% to the protocol FeeVault.

## Crossed status

`$50,000` is a status milestone, not a migration. `isCrossed(token)` reflects the live pool price. `markCrossed(token)` permanently stores the status and emits `TokenCrossed`; it does not move liquidity or change trading.

## Indexing and trading

Indexers can discover the market from the canonical Uniswap V3 `PoolCreated`, `Mint`, and `Swap` events in the launch block. ArcOrigin indexes the `TokenLaunched` event, validates the canonical pool, quotes through the official Quoter, trades through the official Router, and builds charts from pool `Swap` events.

## Deployment gate

The Factory starts paused. The deployment script only creates a paused candidate owned directly by the production 2-of-3 Governance Safe; the deployer never receives Factory ownership. Activation requires a separate reviewed Safe batch that authorizes FeeVault access, selects the Factory in CreatorRegistry, and unpauses launches. Do not activate a candidate without source verification, an independent contract review, a test launch on a fork or testnet, and a coordinated UI/indexer cutover.
