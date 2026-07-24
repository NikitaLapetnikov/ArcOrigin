# ArcOrigin

ArcOrigin is a USDC-native token launch and discovery layer for Arc. This repository contains a Next.js product interface and a local, tested Solidity protocol implementation for fixed-supply launches and virtual-reserve bonding curves.

## Current status

- Frontend: real Arc Testnet approval, launch, trade, chart, holder, and fee flows backed by confirmed onchain data.
- Contracts: deployed to Arc Testnet; source is tested but not independently audited.
- Arc Testnet: chain ID `5042002`, RPC and Arcscan configured.
- Official Arc Testnet USDC: `0x3600000000000000000000000000000000000000`; ArcOrigin deployment addresses are recorded in `deployment/arc-testnet.json`.

The production interface does not insert simulated token listings or trading activity. Nothing in this repository is an audit claim or investment advice.

## Local development

Requirements: Node.js 20+ and pnpm.

```bash
pnpm install
pnpm contracts:compile
pnpm contracts:test
pnpm dev
```

Copy `.env.example` to `.env`. `PINATA_JWT` enables wallet-authorized image and token metadata uploads to public IPFS; keep it server-only. A Pinata V3 key should include `org:files:write`; legacy keys scoped to `pinFileToIPFS` are supported through a compatibility fallback. `IPFS_GATEWAY_URL` is optional and defaults to Pinata's public gateway.

Validation:

```bash
pnpm typecheck
pnpm lint
pnpm build
```

## Contracts

The deployed Arc Testnet contracts retain their original `ArcForge*` Solidity names. The ArcOrigin product rebrand does not alter deployed bytecode, ABIs, or token identity.

- `ArcForgeToken`: fixed supply, immutable creator/factory, immutable launch metadata, no owner controls.
- `ArcForgeBondingCurve`: virtual-USDC-reserve constant product buys/sells with min-output protection. Current V4 curves split trading fees onchain and graduate into a permanent real-reserve AMM without a spot-price jump, so both buys and sells continue.
- `ArcForgeFactory`: validates launches, collects a fixed launch fee, deploys token and curve, records creators.
- `ArcForgeFeeVault`: pulls and records real ERC-20 fees by source; withdraws only to the visible recipient.
- `ArcForgeCreatorRegistry`: creator metadata and factory-recorded launch counts.
- `MockUSDC`: unrestricted minting for local tests only.

The ArcOrigin launch flow uses zero free creator allocation, a 25 USDC launch fee, and 1% buy/sell fees. Creators can acquire tokens only through an optional paid developer buy capped at 5% of supply. V4 splits each trading fee onchain: 70% is transferred directly to the creator and 30% goes to the protocol FeeVault. Current launches use a 2,500 virtual-USDC reserve and graduate after raising 10,000 real USDC: 80% of curve inventory has then been sold, and the remaining inventory is rebalanced at the same price into 10,000 USDC of permanent two-sided liquidity (about 20,000 USDC TVL). Surplus tokens are irreversibly locked and the curve exposes no liquidity-withdrawal function. The public market index exposes only V4 launches using the 10,000 USDC graduation target.

Launch metadata uses an immutable `ipfs://` CID stored by the token contract. The upload endpoint validates and optimizes images, requires a one-time wallet signature bound to the exact metadata payload, rate-limits uploads by wallet and client, and never exposes the storage credential to the browser.

### Deploy to Arc Testnet

The deployment script pins and validates Circle's official Arc Testnet USDC contract, chain ID, token symbol/decimals, contract bytecode, and deployer gas balance before sending transactions. Copy `.env.example` to `.env`, populate `FEE_RECIPIENT` and `DEPLOYER_PRIVATE_KEY`, then:

```bash
pnpm contracts:test
pnpm deploy:arc-testnet
pnpm verify:arc-testnet
```

The deployment script refuses placeholders and writes a gitignored local manifest. The public testnet manifest contains no secrets. Arcscan source verification and an independent audit are still required before any mainnet use.

Factory-only upgrades use separate deployment and activation commands so the new Factory can be inspected and the multi-factory indexer deployed before `CreatorRegistry` is changed:

```bash
pnpm deploy:arc-testnet:v4
pnpm deploy:arc-testnet:v4:activate
```

## VPS deployment

On Ubuntu, install Node.js 20, nginx, Certbot, pnpm, and PM2. Clone the repository, then:

```bash
pnpm install --frozen-lockfile
pnpm contracts:compile
pnpm contracts:test
pnpm build
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Copy `deploy/nginx.arcorigin.conf` to `/etc/nginx/sites-available/arcorigin`, symlink it into `sites-enabled`, validate with `nginx -t`, reload nginx, then request TLS:

```bash
certbot --nginx -d arcorigin.xyz -d www.arcorigin.xyz
```

Run package and OS upgrades deliberately rather than unattended on a production host; validate the build after upgrades and retain a rollback artifact.

## Production work still required

1. Confirm official Arc mainnet and USDC addresses.
2. Independent smart-contract audit and formal deployment review.
3. Contract source verification on Arcscan.
4. Durable event indexer and PostgreSQL persistence.
5. Live buy/sell routing for indexed tokens and resilient transaction-state recovery.
6. Graduation/migration design, implementation, and tests.
7. Monitoring, rate limiting, backups, and incident response.

Not financial advice. Token launches are risky.
