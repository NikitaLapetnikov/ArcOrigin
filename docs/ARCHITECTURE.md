# ArcOrigin architecture

ArcOrigin launches every token directly into a canonical Uniswap V3 pool. There is no separate bonding curve and no migration lifecycle.

## Launch transaction

Each successful launch is atomic:

1. Deploy an ERC-20 with an initial supply of 1 billion tokens and no owner, mint, tax, pause, or blacklist hooks. A holder may burn only tokens it owns.
2. Create or initialize the canonical token/USDC Uniswap V3 pool at a $5,000 starting market cap using the official 1% fee tier.
3. Mint a single-sided LP position with the launch token supply.
4. Send the LP NFT directly to the immutable liquidity locker.
5. Burn any token dust caused by Uniswap rounding, so the LP principal equals the effective total supply.
6. Permanently register whether automatic buyback is enabled and, for enabled pools, request 32 Uniswap observations.
7. Emit `TokenLaunched(token, pool, creator, name, symbol, positionId)` and `AutomaticBuybackConfigured(token, positionId, enabled)`.

Token deployment uses a parent-block-bound `CREATE2` salt. A searcher can still make one launch transaction revert by front-running an initialization for its predicted pool, but the next block derives a different token address; a poisoned pool cannot permanently brick the Factory nonce.

The locker has no NFT transfer, approval, liquidity decrease, rescue, or administrative mutation function. For ordinary positions, anyone can collect accrued LP fees and the locker sends 70% to the creator and 30% to the protocol FeeVault.

## Automatic buyback and burn

Automatic buyback is optional and immutable after launch. For enabled positions, the creator permanently forfeits its 70% fee payout:

- launch-token fees are burned as soon as fees are collected;
- USDC fees accumulate in a reserve isolated by position ID;
- once the reserve is at least 1 USDC, any account may atomically collect fees, swap reserve USDC for the launch token through the immutable official Router and canonical pool, and burn the output;
- execution has a 15-minute cooldown, checks a 15-minute Uniswap TWAP against spot with a maximum 600-tick deviation, and limits sqrt-price movement to 2%;
- the executor receives 0.5% of USDC actually spent, capped at 1 USDC. The protocol's 30% share never enters the reserve.

The VPS keeper only automates this permissionless call. It owns no LP, has no configuration authority, and can be replaced by any caller. If simulation fails because the reserve, TWAP, or cooldown is not ready, no transaction is submitted and no fees move.

## Crossed status

`$50,000` is a status milestone, not a migration. `isCrossed(token)` reflects the live pool price. `markCrossed(token)` permanently stores the status and emits `TokenCrossed`; it does not move liquidity or change trading.

## Indexing and trading

Indexers can discover the market from the canonical Uniswap V3 `PoolCreated`, `Mint`, and `Swap` events in the launch block. ArcOrigin indexes the `TokenLaunched` event, validates the canonical pool, quotes through the official Quoter, trades through the official Router, and builds charts from pool `Swap` events.

### Dedicated event pipeline

Production uses this event path:

`Arc RPC pool → event indexer worker → Postgres event store → Redis hot cache/pub-sub → SSE → frontend`

The worker starts at the active Factory deployment block and indexes only the active ArcOrigin Factory, its launched tokens, canonical pools, and liquidity locker. Event identity is `transactionHash:logIndex`, so overlapping batches and restarts are idempotent. A two-block confirmation buffer is used by default. Every checkpoint stores the block hash; if that hash becomes non-canonical, the worker rolls back orphaned events, rebuilds launch and holder materializations, and resumes from the latest common block.

Postgres stores normalized `TokenLaunched`, `AutomaticBuybackConfigured`, `Swap`, `Transfer`, and `BuybackExecuted` events. Holder balances are incrementally materialized from confirmed transfers. Market snapshots read their price, trade history, volume and pool reserve from one worker checkpoint, while profiles read wallet balances from the same materialization; this avoids adding slow public-RPC reads to the live UI path. Redis stores the latest worker status and a bounded replay list, then publishes new `launch`, `swap`, `holder_change`, and `buyback` messages to `/api/onchain/events`. The frontend applies these messages immediately and continues bounded HTTP polling in the background. If Postgres, Redis, SSE, or the worker is unavailable, existing RPC/explorer snapshots and direct contract reads remain the fallback rather than returning unverified data.

## Deployment gate

The Factory starts paused. The deployment script only creates a paused candidate owned directly by the production 2-of-3 Governance Safe; the deployer never receives Factory ownership. Activation requires a separate reviewed Safe batch that authorizes FeeVault access, selects the Factory in CreatorRegistry, and unpauses launches. Do not activate a candidate without reproducible creation-bytecode verification against the published source commit, an independent contract review, a mainnet-fork test launch, and a coordinated UI/indexer cutover. Arc mainnet explorer source verification is currently unavailable.
