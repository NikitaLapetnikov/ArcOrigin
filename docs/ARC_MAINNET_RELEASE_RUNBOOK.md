# Arc mainnet release runbook

This runbook prepares ArcOrigin for Arc mainnet without removing Arc Testnet. It
does not authorize a mainnet deployment by itself. Every production transaction
must still be reviewed and approved by the designated signers.

## Current production deployment

ArcOrigin V6 mainnet is active. The canonical public deployment record is
[`deployment/arc-mainnet.json`](../deployment/arc-mainnet.json).

| Component | Address |
| --- | --- |
| Factory V6 | `0x2dAED890c8920428e0215583aaC98332447a8170` |
| FeeVault V6 | `0x07287313ee649efcF22EAEE4361cd6c512219B61` |
| CreatorRegistry V6 | `0xA4DbA45B199287d3163199A86B4618968d8f8424` |
| CurveDeployer V6 | `0xd7D2e4Ce4548330f52fc2F79F8524E6e32576013` |
| Migration adapter | `0xc3EF95C4afDe66537acC40011ED5c6e505126a21` |
| Liquidity locker | `0xC41DA72afE97f8fbCA9722f893519cF2972cFb0e` |
| Migration verifier | `0xAA949a795CB1bCc15E4c1AA2DC18a548b9f483c9` |
| Governance/Treasury Safe | `0xa6eA2380F98700AD5CA8B9F74dC8861269513779` |
| Canonical USDC | `0x3600000000000000000000000000000000000000` |

Activation was deliberately split into two Safe operations:

- migrations:
  `0xe699d96ff521bed7d57e36651337558b74a63fbda0c2250c3b24006b8c1da912`;
- launches:
  `0x1244450d5ceaa0e14792bace5a879284910469c24ab42d341a06092680e28ee0`.

Post-execution verification confirmed both receipts with `status=1`,
`launchesPaused=false`, `migrationPaused=false`, and configuration hash
`0x014dab2eb4a6c624beb2d50c873a2792683519bede450c548023758913a0b640`.

## Release architecture

Use two isolated deployments of the same commit:

| Environment | Suggested URL | Build selector | Chain |
| --- | --- | --- | --- |
| Mainnet | `https://arcorigin.xyz` | `NEXT_PUBLIC_ARC_NETWORK=mainnet` | Arc `5042` |
| Testnet | `https://testnet.arcorigin.xyz` | `NEXT_PUBLIC_ARC_NETWORK=testnet` | Arc Testnet `5042002` |

Do not make one running service change its chain at runtime. Separate services
give each network its own contract addresses, RPC pool, Redis/cache namespace,
logs, incident controls, and deployment history. The header links between the
two environments using `NEXT_PUBLIC_MAINNET_APP_URL` and
`NEXT_PUBLIC_TESTNET_APP_URL`.

Mainnet builds fail closed unless the mainnet RPC, explorer, Factory deployment
block, Factory, FeeVault, CreatorRegistry, and canonical USDC addresses are
configured. Testnet keeps its current V6 contracts and data.

## Mainnet invariants

- Chain ID is exactly `5042`.
- The ERC-20 USDC interface is the canonical predeploy
  `0x3600000000000000000000000000000000000000`, with 6 decimals and symbol
  `USDC`.
- Native gas accounting uses Arc's native USDC representation; token settlement
  uses the 6-decimal ERC-20 interface. Never reuse ERC-20 unit conversion for
  native gas balances.
- The deployer is a dedicated, expected EOA and is only a temporary owner.
- Treasury and governance roles are deployed contracts, not unreviewed EOAs.
- Factory launches are paused immediately after deployment.
- DEX migration is configured while launches remain paused. The migration tuple
  is snapshotted into every new curve at launch.
- Factory, FeeVault, and CreatorRegistry are owned directly by the reviewed
  2-of-3 Governance Safe before public activation.
- Migration configuration and launch activation are separate Safe operations.

## Required inputs

Copy `.env.example` to a local, ignored `.env` and fill all mainnet fields. Never
send or commit private keys.

Required before preflight:

```dotenv
ARC_MAINNET_RPC_URL=https://rpc.blockdaemon.mainnet.arc.io
NEXT_PUBLIC_ARC_MAINNET_RPC_URL=https://rpc.blockdaemon.mainnet.arc.io
NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL=https://arc-mainnet.cloud.blockscout.com
NEXT_PUBLIC_ARC_MAINNET_EXPLORER_API_URL=https://arc-mainnet.cloud.blockscout.com/api
MAINNET_EXPLORER_URL=https://arc-mainnet.cloud.blockscout.com
MAINNET_DEPLOYER_PRIVATE_KEY=...
MAINNET_EXPECTED_DEPLOYER=0x...
MAINNET_GOVERNANCE_SAFE=0x...
MAINNET_GOVERNANCE_SAFE_OWNERS=0x...,0x...,0x...
MAINNET_TREASURY_SAFE=0x...
MAINNET_EMERGENCY_GUARDIAN=0x...
```

The public Blockdaemon, Thirdweb, and Blockscout RPC endpoints were observed
returning chain ID `5042`. The committed network probe verifies the configured
endpoint and pinned runtime hashes before any deployment preflight. Prefer a
dedicated Arc RPC for deployment once the provider issues one; do not bypass
the probe when changing endpoints.

The Governance Safe and Treasury Safe must be independently reviewed
multi-signature wallets. ArcOrigin V6 mainnet uses the reviewed 2-of-3
Governance Safe as the direct owner of Factory, FeeVault, and CreatorRegistry.
The deployed Timelock is not part of the active ownership path.

## Phase 1 — offline and RPC preflight

Run from a clean, reviewed commit:

```bash
pnpm install --frozen-lockfile
pnpm contracts:compile
pnpm contracts:test
pnpm typecheck
pnpm lint
pnpm build
pnpm network:verify:arc-mainnet
pnpm preflight:arc-mainnet:v6
```

The preflight sends no transaction. It checks chain ID, deployer identity,
contract code for Safe/guardian/USDC, USDC metadata, and the deployer's native
gas balance.

Record:

- exact Git commit;
- Solidity compiler and optimizer settings;
- RPC provider and endpoint owner;
- Safe owners and threshold;
- direct Governance Safe owners, threshold, and address;
- deployer address and funded amount;
- expected contract creation addresses from a fork rehearsal.

## Phase 2 — deploy a paused candidate

Only after two reviewers approve the preflight:

```bash
pnpm deploy:arc-mainnet:v6
```

The command deploys V6 FeeVault, CreatorRegistry, CurveDeployer, and Factory,
then immediately pauses Factory launches. It binds CurveDeployer once,
authorizes the Factory in FeeVault, selects the Factory in CreatorRegistry, and
writes the ignored candidate manifest:

```text
deployment/arc-mainnet-v6.local.json
```

The command intentionally deploys migration disabled and paused. Do not point
the mainnet UI at this candidate yet.

## Phase 3 — reproduce and verify bytecode

```bash
pnpm verify:arc-mainnet:v6
pnpm verify:sources:arc-mainnet:v6
```

Publish verified Solidity source and exact constructor arguments in the
reviewed Arc explorer. Independently reproduce the runtime comparison from a
second machine. Record explorer links and runtime code hashes in the release
ticket.

Do not run a public smoke launch while the migration tuple is empty. Exercise
launch, buy, sell, creator claims, graduation, and migration on a mainnet fork
using the exact deployed bytecode and current Arc state.

## Phase 4 — prepare Uniswap migration

ArcOrigin V6 deliberately does not hardcode a Uniswap router. A curve accepts
only the immutable tuple:

1. ArcOrigin migration adapter;
2. permanent liquidity locker;
3. independent migration verifier.

All three runtime code hashes are snapshotted by each curve. Migration is
atomic, clears approvals, verifies actual token/USDC deltas, and remains
fail-closed if code or configuration changes.

The official Uniswap SDK currently records these Arc mainnet deployments:

```dotenv
UNISWAP_V3_FACTORY=0xf0db7b58379503491d857db50ac9ece64c653918
UNISWAP_V3_POSITION_MANAGER=0x39654a85a4c05127f5fd6ed22caec077a0fb1377
UNISWAP_V3_QUOTER=0x7dfd4f31be6814d2906bde155c3e1b146eac1468
UNISWAP_V3_SWAP_ROUTER=0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77
UNISWAP_MIGRATION_VERSION=v3
UNISWAP_V3_FACTORY_CODEHASH=0x621c4819f7b62d7ddb153206bc30950bcc3f5cc9d24c45661f8c2f31dcbd166d
UNISWAP_V3_POSITION_MANAGER_CODEHASH=0xcad0552151ba7675afe512ebe77fcc6eed68a0cb65775d31e38d44823e6796a0
UNISWAP_V3_QUOTER_CODEHASH=0xf222999269407743c526ee7c9d0c9b4fabec26773d48fd6fd257c5ebca976ea7
UNISWAP_V3_SWAP_ROUTER_CODEHASH=0xc53680bc70e67f7e8818a0e1302e9b70a4460493bc6dd6db056575b17cb3af25
```

Source: the `ARC_ADDRESSES` entry in the
[official Uniswap SDK](https://github.com/Uniswap/sdks/blob/main/sdks/sdk-core/src/addresses.ts).
RadarDex publicly uses the same V3 Factory ecosystem for direct launches, but
its application contracts are not a trust dependency for ArcOrigin.

ArcOrigin's reviewed implementation is intentionally different from
RadarDex's direct-launch model:

- the V6 curve remains the only trading venue until graduation;
- migration creates a canonical 1% Uniswap V3 pool at the exact reserve ratio;
- at least 99.90% of both accounted assets must enter one full-range position;
- the LP NFT is minted directly to an immutable locker that has no transfer,
  decrease-liquidity, burn, rescue, or admin path;
- permissionless fee collection pays 70% to the recorded token creator and
  30% to the V6 FeeVault;
- an independently deployed verifier reads Factory, pool, LP NFT, locker,
  token balances, token ordering, fee tier, tick range, initial price, and
  principal before V6 can zero its internal reserves;
- the app verifies the migrated canonical pool, obtains exact-input quotes from
  the official Quoter, submits swaps to SwapRouter02, and indexes V3 `Swap`
  events after migration.

Deploy the immutable migration stack while Factory launches and migrations are
still paused:

```bash
pnpm deploy:migration:arc-mainnet:v6
```

The command fails closed unless chain `5042`, canonical USDC, V6 Factory,
FeeVault, official V3 contracts, 1% fee tier, deployer, and pause state all
match. It deploys Adapter → Locker → Verifier, verifies their immutable
bindings, writes a gitignored manifest with runtime code hashes, and **does not**
configure or enable Factory migration.

Before configuration:

- re-confirm the canonical Arc Uniswap deployment addresses at the exact
  reviewed SDK commit;
- use only the reviewed V3 implementation in this release; the readiness
  checker rejects every other migration version;
- independently audit the adapter, locker, verifier, tick/range policy,
  token-order logic, price conversion, fee tier, slippage bounds, position
  ownership, fee ownership, and emergency behavior;
- store the verified runtime hashes in the mainnet environment;
- rehearse successful and adversarial migrations on a current Arc mainnet fork.

The adapter rejects a pool that already exists for the token/USDC 1% pair.
This prevents an attacker-controlled initial price or pre-existing liquidity
from being accepted. The trade-off is availability: an external account can
pre-create that pool and block migration for that token. No curve funds move in
that case, `migrateToDex()` reverts atomically, and the graduated V6 internal AMM
continues trading. Treat this as an explicit operational limitation until a
subsequent audited protocol version reserves the deterministic pool in the
token-launch transaction.

Build the three separate governance operations:

```bash
pnpm migration:operations:arc-mainnet:v6
```

Review every operation's `target`, `value`, and `calldata` before submitting it
as a separate transaction through the 2-of-3 Governance Safe. Do not submit any
Factory operation until Phase 5 confirms direct Safe ownership.

Order:

1. `setMigrationConfiguration(adapter, locker, verifier)` — automatically keeps
   migration paused;
2. run the readiness checker and fork rehearsal again;
3. `unpauseMigrations()` only after all gates pass;
4. `unpauseLaunches()` last.

Never combine configuration and activation in one Safe batch. Every token
launched before step 1 permanently snapshots an empty migration tuple and
cannot later use that Uniswap path.

## Phase 5 — governance handoff

Prepare the fail-closed direct Safe handoff:

```bash
pnpm governance:prepare-direct-safe:arc-mainnet:v6
```

The temporary deployer submits `transferOwnership(governanceSafe)` separately
for Factory, FeeVault, and CreatorRegistry. Review the generated Safe batch,
which atomically cancels any superseded Timelock handoff and calls
`acceptOwnership()` on all three targets.

After the 2-of-3 Safe executes the batch, verify the exact execution
transaction:

```bash
V6_DIRECT_SAFE_EXECUTION_TX_HASH=0x... \
  pnpm governance:verify-direct-safe:arc-mainnet:v6
```

Factory, FeeVault, and CreatorRegistry must all report the Governance Safe as
owner and the zero address as pending owner. Any superseded Timelock operation
must report neither pending, ready, nor done.
CurveDeployer must remain permanently bound to the Factory with owner `0x0`.
Only after those reads pass may the Governance Safe execute the three separate
migration operations prepared in Phase 4.

## Phase 6 — readiness gate

Fill the deployed contract, migration, Uniswap, and runtime code-hash values in
the ignored mainnet environment. The checker requires the Factory to remain
launch-paused and migration-paused:

```bash
pnpm readiness:arc-mainnet:v6
```

It validates:

- chain and canonical USDC;
- full protocol wiring;
- direct Governance Safe ownership and Treasury Safe recipient;
- Factory collector/registrar permissions;
- renounced CurveDeployer ownership;
- exact ArcOrigin migration code hashes;
- exact Uniswap code hashes and V3 PositionManager-to-Factory linkage when V3
  is selected;
- immutable Adapter/Locker/Verifier bindings, the 1% fee tier, 70/30 split,
  99.90% minimum asset usage, FeeVault recipient, and public
  Factory/PositionManager/Quoter/SwapRouter parity;
- explicit source verification, independent audit, reorg-indexer, and
  monitoring release gates.

The command exits non-zero until every gate is true.

## Phase 7 — deploy the two web environments

First preserve the existing testnet:

1. create `testnet.arcorigin.xyz`;
2. deploy the current service with `NEXT_PUBLIC_ARC_NETWORK=testnet`;
3. confirm launches/trades/cache/history still use chain `5042002`;
4. set `NEXT_PUBLIC_MAINNET_APP_URL=https://arcorigin.xyz`.

Then create a separate mainnet service from the exact same commit:

```dotenv
NEXT_PUBLIC_ARC_NETWORK=mainnet
NEXT_PUBLIC_PROTOCOL_VERSION=6
NEXT_PUBLIC_TESTNET_APP_URL=https://testnet.arcorigin.xyz
NEXT_PUBLIC_MAINNET_APP_URL=https://arcorigin.xyz
NEXT_PUBLIC_MAINNET_FACTORY_ADDRESS=0x2dAED890c8920428e0215583aaC98332447a8170
NEXT_PUBLIC_MAINNET_FACTORY_FROM_BLOCK=12881762
NEXT_PUBLIC_MAINNET_FEE_VAULT_ADDRESS=0x07287313ee649efcF22EAEE4361cd6c512219B61
NEXT_PUBLIC_MAINNET_CREATOR_REGISTRY_ADDRESS=0xA4DbA45B199287d3163199A86B4618968d8f8424
NEXT_PUBLIC_UNISWAP_V3_FACTORY=0xf0db7b58379503491d857db50ac9ece64c653918
NEXT_PUBLIC_UNISWAP_V3_POSITION_MANAGER=0x39654a85a4c05127f5fd6ed22caec077a0fb1377
NEXT_PUBLIC_UNISWAP_V3_QUOTER=0x7dfd4f31be6814d2906bde155c3e1b146eac1468
NEXT_PUBLIC_UNISWAP_V3_ROUTER=0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77
NEXT_PUBLIC_MAINNET_USDC_ADDRESS=0x3600000000000000000000000000000000000000
```

Give mainnet a separate `REDIS_URL`, dedicated server RPC, upload limits,
monitoring, and alert routes. Deploy it behind a private/canary hostname first.
Verify that the header network control crosses between services rather than
mutating the connected chain inside one cached application.

The concrete checkpoint, health endpoint, monitor, alert, and incident
procedures are documented in
[`INDEXER_AND_MONITORING_RUNBOOK.md`](./INDEXER_AND_MONITORING_RUNBOOK.md).
Before marking the indexer and monitoring gates complete, run:

```bash
pnpm test:indexer-resilience
pnpm test:production-health
pnpm monitor:production
```

## Activation

Activation is allowed only when:

- readiness exits successfully;
- source verification and independent review records are linked;
- mainnet indexer has passed reorg, restart, duplicate-log, and backfill tests;
- monitoring covers RPC failures, indexing lag, reverted transactions, vault
  balances, owner/guardian/config changes, and migration events;
- incident owners have rehearsed pause and recovery;
- the mainnet UI is pinned to the exact reviewed commit and candidate addresses.

Prepare two independent, fail-closed Safe Transaction Builder files:

```bash
pnpm activation:prepare:arc-mainnet:v6
```

This command verifies direct Safe ownership, the exact reviewed Safe owner set,
the configured migration tuple and configuration hash, and that both launch and
migration switches are still paused. It sends no transaction.

Import and execute only the migration batch first. After finality, verify it
while launches remain paused:

```bash
V6_ACTIVATION_PHASE=migrations \
V6_MIGRATION_ACTIVATION_TX_HASH=0x... \
  pnpm activation:verify:arc-mainnet:v6
```

Only then import the separate launch batch. After finality, verify the complete
activation:

```bash
V6_ACTIVATION_PHASE=launches \
V6_MIGRATION_ACTIVATION_TX_HASH=0x... \
V6_LAUNCH_ACTIVATION_TX_HASH=0x... \
  pnpm activation:verify:arc-mainnet:v6
```

Never merge the two calls into one Safe transaction. After each phase, wait for
finality and re-run readiness with the matching expected pause state.

## Rollback and incidents

- Frontend incident: remove the mainnet custom domain or roll back the web
  release. Never repoint it to testnet contracts.
- Indexer incident: show the last confirmed snapshot and disable writes that
  cannot be safely quoted.
- Contract incident: guardian pauses launches/migrations where authorized; the
  2-of-3 Safe executes corrective governance.
- Uniswap migration incident: keep migration paused. Graduation continues
  through V6's internal permanent AMM; do not bypass verifier checks.
- Never delete the testnet service, manifest, or DNS record during a mainnet
  rollback.
