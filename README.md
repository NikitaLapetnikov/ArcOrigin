# ArcOrigin

ArcOrigin is a non-custodial, USDC-native token launch and discovery product for Arc. Every new token launches directly into its canonical Uniswap V3 pool; there is no separate bonding curve or later liquidity migration.

The deployment gate, reviewed invariants, findings, and residual risks are documented in `audit/SECURITY_REVIEW.md`.

## Architecture

- Initial supply: 1,000,000,000 tokens, no owner, mint, tax, blacklist, or pause. Holders may burn only their own balance.
- Launch: the Factory creates the token, initializes the token/USDC 1% pool at a 5,000 USDC market cap, mints the single-sided LP position, and locks its NFT atomically.
- Liquidity: the immutable locker has no withdrawal path.
- Status: 50,000 USDC changes the token status to `Crossed`; it does not move or unlock liquidity.
- Fees: ordinary launches split collected LP fees 70% to the creator and 30% to the protocol Fee Vault.
- Automatic buyback: a creator may irreversibly opt in at launch. The creator's 70% token-side fees burn immediately; its USDC-side fees fund permissionless TWAP-protected token buybacks and burns. The protocol share remains 30%.
- Indexing: the app indexes only the configured active Factory and canonical Uniswap `Swap` events. Previous deployments and token lists are not loaded.
- Live delivery: a dedicated worker writes canonical events and materialized holder balances to Postgres, publishes hot events through Redis, and streams them to the frontend over SSE. Polling remains a recovery path.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for contract invariants and integration details.

## Local development

Requirements: Node.js 20+ and npm.

```bash
cp .env.example .env
npm install
npm run dev
```

`PINATA_JWT` is server-only and enables wallet-authorized image and metadata uploads to public IPFS. Production uses Postgres as the canonical event store and Redis for snapshots, indexer status, SSE replay and pub/sub. If either live component is unavailable, the existing bounded RPC scans and browser polling remain available as fallbacks.

Run the dedicated indexer next to the web application:

```bash
DATABASE_URL=postgresql://... REDIS_URL=redis://... npm run indexer:events
```

The worker applies the ordered SQL files in `deploy/postgres/` idempotently, resumes from its last canonical checkpoint, rolls back orphaned blocks, and indexes ArcOrigin launches, Uniswap swaps, ERC-20 holder changes and automatic buybacks. Market snapshots and profile balances use that confirmed Postgres checkpoint directly; the frontend consumes `/api/onchain/events` over SSE and keeps polling plus direct RPC reads as recovery paths.

Protocol analytics aggregate the same canonical Postgres checkpoint. Each time range is coalesced into one server refresh, cached briefly in process, persisted to Redis as a stale-safe snapshot, and invalidated by live indexer events. The API never fans out into per-token RPC requests, and database indexes keep global swap and buyback time-range queries bounded as history grows.

Swap traders are attributed from the indexed token transfer flow, not from Uniswap's intermediary `recipient`. Run `npm run backfill:trader-wallets` to preview historical corrections, then `npm run backfill:trader-wallets -- --apply` to update stored Swap wallets and invalidate affected analytics caches. The backfill uses `tx.from` only when the indexed transfer flow is incomplete.

Set `NEXT_PUBLIC_ARC_MAINNET_RPC_FALLBACK_URLS` to a comma-separated list of independently operated Arc RPC endpoints. Browser reads continuously rank that pool by stability and latency, while server snapshots and the optional keeper fail over when the primary RPC is unavailable. `ARC_MAINNET_QUOTE_RPC_URLS` may provide a server-only, comma-separated ordering for endpoints that reliably support Uniswap Quoter `eth_call` requests. Live quotes prefer the deduplicated server endpoint and start a short browser-side hedge only when it is slow. Initial token pages render the latest Redis market, holder, and buyback snapshots; SSE then applies new indexed events immediately, with bounded polling retained only as recovery.

Useful checks:

```bash
npm run typecheck
npm run lint
npm run contracts:compile
npm run contracts:test
npm test
npm run build
pnpm audit --prod
```

## Configuration

The application requires exactly one active Factory per selected network. Configure its address and deployment block together with Fee Vault, Creator Registry, canonical USDC, and Uniswap endpoints. Do not add previous factories as fallbacks.

Arc mainnet uses chain ID `5042` and canonical USDC `0x3600000000000000000000000000000000000000`. Official Uniswap addresses are validated by the deployment preflight.

## Deployment

Verify the Arc network and deploy a paused candidate:

```bash
npm run preflight:arc-mainnet
npm run deploy:arc-mainnet
```

The deploy script writes `deployment/arc-mainnet.local.json` and an unsigned Safe activation batch. It does not enable launches. Before activation, require an independent contract review, verified source code, a mainnet-fork rehearsal, and coordinated application/indexer configuration.

Never commit private keys, RPC credentials, Pinata tokens, Redis credentials, or Safe signer material.

The optional platform keeper is a permissionless executor, not an administrator. Run `npm run keeper:buyback` as a one-shot job with `BUYBACK_KEEPER_RPC_URL`, `BUYBACK_KEEPER_RPC_FALLBACK_URLS`, `BUYBACK_KEEPER_PRIVATE_KEY`, and `BUYBACK_KEEPER_FACTORY_ADDRESS` supplied through a protected VPS environment file. `BUYBACK_KEEPER_RPC_MINIMUM_SPACING_MS` may be set to pace calls when a provider enforces strict rate limits (the safe default is 500 ms). Only healthy, authenticated fallback endpoints should be configured. The included systemd timer runs it every five minutes and bounds each attempt to four minutes. The keeper key must be a dedicated, minimally funded operational account and must never be a Safe owner.

## Security

Token trading is irreversible and highly risky. Permanent LP custody prevents liquidity withdrawal but does not guarantee demand, price stability, market depth, contract correctness, or token quality. Report vulnerabilities through the process in [SECURITY.md](./SECURITY.md).
