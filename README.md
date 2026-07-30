# ArcOrigin

ArcOrigin is a USDC-native token launch and discovery layer for Arc. This repository contains a Next.js product interface and a local, tested Solidity protocol implementation for fixed-supply launches and virtual-reserve bonding curves. Testnet and mainnet use separate deployments of the same codebase and never share contract or indexer configuration.

## Current status

- Frontend: Arc mainnet is the production environment; launches, trades, charts, holders, creator claims, and fees use confirmed onchain data.
- Contracts: V6 is active on Arc mainnet and Arc Testnet. Mainnet Factory, FeeVault, and CreatorRegistry are owned directly by the reviewed 2-of-3 Governance Safe.
- Arc mainnet: chain ID `5042`; Factory launches and the verified Uniswap V3 migration route are active. Canonical addresses and activation transactions are recorded in [`deployment/arc-mainnet.json`](./deployment/arc-mainnet.json).
- Arc Testnet: chain ID `5042002`; the isolated testnet deployment remains available for development and does not share contracts or cached state with mainnet.
- Canonical Arc USDC: `0x3600000000000000000000000000000000000000`.

The production interface does not insert simulated token listings or trading
activity. The internal review and unresolved mainnet blockers are documented in
[`SECURITY.md`](./SECURITY.md). The repeatable 2026-07-30 V6 review evidence,
invariants, Slither triage, deployed bytecode identity, and mainnet activation
procedure are collected in
[`audit/internal-v6-2026-07-30`](./audit/internal-v6-2026-07-30/README.md).
Nothing in this repository is an independent audit claim or investment advice.

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

Select the target web environment at build time with
`NEXT_PUBLIC_ARC_NETWORK=mainnet|testnet`. The production default in
`.env.example` is mainnet. Testnet remains an explicit, separate build and
must use its own contracts, deployment block, Redis/cache namespace, and URL.
The header links between deployments; one running index never mixes chains.

## Contracts

The deployed contracts retain their original `ArcForge*` Solidity names. The ArcOrigin product rebrand does not alter deployed bytecode, ABIs, or token identity.

- `ArcForgeToken`: fixed supply, immutable creator/factory, immutable launch metadata, no owner controls.
- `ArcForgeBondingCurve`: virtual-USDC-reserve constant product buys/sells with min-output protection. Current V4 curves split trading fees onchain and graduate into a permanent real-reserve AMM without a spot-price jump, so both buys and sells continue.
- `ArcForgeFactory`: validates launches, collects a fixed launch fee, deploys token and curve, records creators.
- `ArcForgeFeeVault`: pulls and records real ERC-20 fees by source; withdraws only to the visible recipient.
- `ArcForgeCreatorRegistry`: creator metadata and factory-recorded launch counts.
- `MockUSDC`: unrestricted minting for local tests only.

V6 adds authorized FeeVault collectors, pull-based creator fee claims, transaction deadlines, exact-transfer accounting, bounded pagination, two-step governance ownership, a pause-only emergency guardian, and graduation that cannot be blocked by optional DEX migration. See [`docs/V6_SECURITY_ARCHITECTURE.md`](./docs/V6_SECURITY_ARCHITECTURE.md).

The ArcOrigin launch flow uses zero free creator allocation, a 10 USDC launch fee, and 1% buy/sell fees. Creators can acquire tokens only through an optional paid developer buy capped at 5% of supply. V6 accrues 70% of each trading fee for creator claims and sends 30% to the protocol FeeVault. Current launches use a 2,500 virtual-USDC reserve and graduate after raising 10,000 real USDC. V6 adds a three-block launch-protection window and fail-safe DEX migration. Mainnet launches snapshot the activated, verified Arc Uniswap V3 adapter/locker/verifier tuple; testnet graduation continues in the permanent internal AMM.

The proposed AORG protocol-token policy routes 80% of allocated protocol revenue through bounded TWAP buybacks and 20% to operations. Bought AORG is sent directly to the burn address. The controller, tests, deployment preflight, and Safe launch sequence are documented in [`docs/AORG_TOKENOMICS_AND_BUYBACK.md`](./docs/AORG_TOKENOMICS_AND_BUYBACK.md). No token or controller is canonical until the Safe launch and governance configuration are complete.

Launch metadata uses an immutable `ipfs://` CID stored by the token contract. The upload endpoint validates and optimizes images, requires a one-time wallet signature bound to the exact metadata payload, rate-limits uploads by wallet and client, and never exposes the storage credential to the browser.

### Deploy to Arc Testnet

The deployment script pins and validates Circle's official Arc Testnet USDC contract, chain ID, token symbol/decimals, contract bytecode, and deployer gas balance before sending transactions. Copy `.env.example` to `.env`, populate `FEE_RECIPIENT` and `DEPLOYER_PRIVATE_KEY`, then:

```bash
pnpm contracts:test
pnpm deploy:arc-testnet
pnpm verify:arc-testnet
```

The deployment script refuses placeholders and writes a gitignored local manifest. The public testnet manifest contains no secrets. Arcscan source verification and an independent audit are still required before any mainnet use.

V6 is deployed as a separate full-stack candidate and never overwrites the active V5 manifest:

```bash
TREASURY_SAFE=0xReviewed2of3Safe \
EMERGENCY_GUARDIAN=0xReviewedSafe \
pnpm deploy:arc-testnet:v6

pnpm verify:arc-testnet:v6
```

The command requires contract addresses for both Safe roles, deploys migration disabled and paused, binds the CurveDeployer permanently, authorizes only the Factory, and writes `deployment/arcTestnet-v6.local.json`. It does not activate the candidate.

### Prepare Arc mainnet

The mainnet deployment script validates chain `5042`, the expected deployer,
Safe/guardian bytecode, canonical USDC metadata, and gas before sending
transactions. It deploys a candidate with launches and migrations paused:

```bash
pnpm network:verify:arc-mainnet
pnpm preflight:arc-mainnet:v6
pnpm deploy:arc-mainnet:v6
pnpm verify:arc-mainnet:v6
pnpm deploy:migration:arc-mainnet:v6
```

These deployment commands create a paused candidate. The canonical deployment
has since completed runtime code-hash checks, source publication, direct 2-of-3
Safe ownership handoff, migration configuration, and separate Safe activation
transactions for migrations and launches. The exact addresses, transaction
hashes, dual-environment procedure, and rollback steps are in
[`docs/ARC_MAINNET_RELEASE_RUNBOOK.md`](./docs/ARC_MAINNET_RELEASE_RUNBOOK.md).

Factory-only upgrades use separate deployment and activation commands so the new Factory can be inspected and the multi-factory indexer deployed before `CreatorRegistry` is changed:

```bash
pnpm deploy:arc-testnet:v4
pnpm deploy:arc-testnet:v4:activate
```

### Governance preparation

The repository includes a fail-closed preparation path for a 2-of-3 Governance Safe and 2-of-3 Treasury Safe. Arc mainnet V6 uses direct Safe ownership; the deployed Timelock is retained only as an unused historical deployment:

```bash
pnpm security:audit-admin:arc-testnet
pnpm governance:deploy:arc-testnet
pnpm governance:handoff:arc-testnet
pnpm governance:verify:arc-testnet
```

The legacy Timelock handoff command is dry-run unless both `EXECUTE_ADMIN_HANDOFF=true` and an exact `CONFIRM_ADMIN_HANDOFF` address are provided. It is not the active Arc mainnet V6 ownership path. Never use placeholder signer addresses or store signer keys in the repository.

The completed mainnet direct-Safe path is prepared and verified with:

```bash
pnpm governance:prepare-direct-safe:arc-mainnet:v6
V6_DIRECT_SAFE_EXECUTION_TX_HASH=0x... \
  pnpm governance:verify-direct-safe:arc-mainnet:v6
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

## Production operations

The canonical Arc mainnet deployment is active. Operators must continuously
monitor Factory ownership and pause state, RPC/indexer lag, metadata storage,
FeeVault balances, and migration events. Any new deployment or governance
change still requires reproducible builds, source publication, two Safe
confirmations, transaction simulation, and post-execution verification.

The repository includes a repeatable internal engineering review. It is not an
independent audit claim; users should evaluate the published source,
deployment, governance, and residual risks themselves.

Not financial advice. Token launches are risky.
