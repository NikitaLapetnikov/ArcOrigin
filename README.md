# ArcOrigin

ArcOrigin is a non-custodial, USDC-native token launch and discovery product for Arc. Every new token launches directly into its canonical Uniswap V3 pool; there is no separate bonding curve or later liquidity migration.

The deployment gate, reviewed invariants, findings, and residual risks are documented in `audit/SECURITY_REVIEW.md`.

## Architecture

- Fixed supply: 1,000,000,000 tokens, no owner, mint, tax, blacklist, or pause.
- Launch: the Factory creates the token, initializes the token/USDC 1% pool at a 5,000 USDC market cap, mints the single-sided LP position, and locks its NFT atomically.
- Liquidity: the immutable locker has no withdrawal path.
- Status: 50,000 USDC changes the token status to `Crossed`; it does not move or unlock liquidity.
- Fees: collected LP fees are split 70% to the creator and 30% to the protocol Fee Vault.
- Indexing: the app indexes only the configured active Factory and canonical Uniswap `Swap` events. Previous deployments and token lists are not loaded.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for contract invariants and integration details.

## Local development

Requirements: Node.js 20+ and npm.

```bash
cp .env.example .env
npm install
npm run dev
```

`PINATA_JWT` is server-only and enables wallet-authorized image and metadata uploads to public IPFS. Redis is optional but recommended in production for persistent index snapshots.

Useful checks:

```bash
npm run typecheck
npm run lint
npm run contracts:compile
npm run contracts:test
npm run build
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

The deploy script writes `deployment/arc-mainnet.local.json` and an unsigned Safe activation batch. It does not enable launches. Before activation, require an independent contract review, verified source code, a fork or testnet launch, and coordinated application/indexer configuration.

Never commit private keys, RPC credentials, Pinata tokens, Redis credentials, or Safe signer material.

## Security

Token trading is irreversible and highly risky. Permanent LP custody prevents liquidity withdrawal but does not guarantee demand, price stability, market depth, contract correctness, or token quality. Report vulnerabilities through the process in [SECURITY.md](./SECURITY.md).
