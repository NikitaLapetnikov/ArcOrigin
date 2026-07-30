# ArcOrigin security review

Last reviewed: 2026-07-30

Scope: Solidity contracts, deployment scripts, wallet transaction flows, metadata/IPFS APIs, RPC/indexing, caches, and production web headers.

## Status and limitations

ArcOrigin V6 is active on Arc mainnet and remains separately deployed on Arc
Testnet. This document records an internal engineering review, not an
independent audit, certification, or bug bounty result. Deployed contracts are
immutable: application fixes in this repository do not change their bytecode.
Contract-level changes require a new deployment and governance activation plan.

Review work included manual source analysis, economic-invariant analysis, contract compilation/tests, TypeScript and ESLint checks, production build verification, and dependency auditing. It did not include formal verification, a professional third-party audit, or exhaustive adversarial testing.

## Review result

No direct unauthorized-withdrawal path or reserve-drain path was found in the reviewed V4 launch, buy, sell, graduation, or FeeVault withdrawal flows.

The web application and indexer were hardened during this review:

- quotes accept only a bounded `uint256` amount and an exact token/curve pair emitted by the configured active Factory;
- newly launched markets are verified directly against the active Factory when the cached index has not caught up yet;
- confirmed trade UI updates decode the actual receipt event instead of reusing a pre-trade quote;
- forced market and launch refreshes bypass delayed explorer data, while headline reserves/price come from contract state at the latest confirmed block;
- holder and launch verification fall back to RPC when Arcscan unexpectedly returns an empty result;
- stale parallel index, market, and holder responses cannot overwrite a newer confirmed or optimistic state;
- wallet reads and transactions use multiple Arc RPC endpoints instead of depending on one rate-limited provider;
- metadata upload requests are same-origin, size-bounded, one-time-signature authorized, rate-limited, and memory-bounded;
- profile update challenges remain wallet-signed, and public profile links never expose edit or disconnect actions to another wallet;
- token names are validated against the Factory's 64-byte limit and control characters are rejected;
- metadata uploaded by one wallet is never reused after switching to another wallet;
- duplicate launch submissions are blocked in the client;
- RPC, Arcscan, IPFS, and image origins are explicitly constrained by the production Content Security Policy;
- public refresh paths are cached, deduplicated, and throttled to reduce RPC exhaustion.

The unused legacy fee-indexing endpoint was removed. It scanned only an older Factory generation, was no longer reachable from the product, and exposed an unnecessary public RPC-heavy route.

The Solidity suite currently covers fixed supply, allocation and metadata bounds, access control, fee changes, fee splitting, slippage, dust rounding, randomized reserve invariants, graduation input caps, price continuity, permanent-liquidity solvency, FeeVault withdrawal rules, and timelocked governance execution.

## Administrative access review

The active Arc mainnet V6 Factory, CreatorRegistry, and FeeVault are owned
directly by the reviewed 2-of-3 Governance Safe
`0xa6eA2380F98700AD5CA8B9F74dC8861269513779`. Factory launches and the
snapshotted Uniswap migration route are active. The deployed historical
Timelock is not in the current ownership path.

The ORIGIN buyback controller is also owned and guarded by that Safe. Its
executor can choose timing within bounded limits but cannot redirect funds or
recover ORIGIN/USDC. The Safe can revoke the executor or pause the controller.
FeeVault withdrawals remain explicit Safe actions.

Administrative reach is bounded:

- Factory changes apply only to future curves because each curve snapshots its fees, economics, launch protection, and migration configuration at deployment.
- CreatorRegistry ownership can select the Factory allowed to record new launches.
- FeeVault ownership can rotate the recipient; only its owner may trigger a V6 withdrawal, and funds always go to the current recipient.
- Existing V5 curves and launched tokens have no owner, upgrade, pause, mint, blacklist, or reserve-withdraw path.

Deployment, direct-Safe handoff, exact-address verification, and operation-calldata
scripts fail closed on invalid Safe policy or role layout. The canonical addresses
and activation transactions are in
[`deployment/arc-mainnet.json`](./deployment/arc-mainnet.json).

## V6 remediation deployment

The active Arc mainnet and testnet V6 stacks remediate the main contract findings from this review:

- graduation always activates the internal permanent AMM and never calls an external adapter;
- DEX migration is a separate, optional transaction and cannot block the final buy;
- migration uses exact accounted balance deltas, so unsolicited donation dust cannot block it;
- adapter, locker, verifier, and their runtime code hashes are snapshotted;
- the Factory can revoke or pause the exact migration tuple without pausing trading;
- a DEX-specific independent verifier must validate pool and locker state;
- creator fees accrue for pull-based claims instead of being pushed during trades;
- FeeVault collectors are authorized, transfers are balance-checked, and only governance may withdraw;
- Factory and Registry use bounded reads, two-step ownership, and disabled ownership renunciation;
- a narrowly scoped guardian may stop only new launches and migrations;
- transaction deadlines and exact-transfer checks are enforced.

V6 has dedicated adversarial/property-oriented tests in addition to the existing
suite and is active on Arc mainnet and Arc Testnet. The full design and release
record are documented in
[`docs/V6_SECURITY_ARCHITECTURE.md`](./docs/V6_SECURITY_ARCHITECTURE.md) and
[`audit/internal-v6-2026-07-30`](./audit/internal-v6-2026-07-30/README.md).

## V5 changes

V5 narrows the Factory to a canonical one-billion supply and zero free creator allocation, reduces the launch fee to 10 USDC, and snapshots launch protection, curve economics, fees, and any DEX migration adapter into each new curve. The initial protection window limits a wallet to 5% holdings and 5.5% cumulative purchases for three blocks.

The external migration boundary is deliberately disabled on Arc Testnet. A curve configured without an adapter retains the permanent internal AMM behavior. A curve configured with an adapter requires graduation to atomically transfer every remaining token and real-USDC reserve; a zero pool address or any residual curve balance reverts the entire migration. Trading on a successfully migrated curve is permanently disabled.

This boundary does not make an unknown adapter safe. Arc mainnet uses the
published ArcOrigin Uniswap V3 adapter, verifier, and immutable LP locker bound
to the official Arc Uniswap deployment. Adapter configuration is snapshotted at
launch and cannot be retrofitted onto an existing curve.

## Contract observations

### Safeguards present

- `ArcForgeToken` has fixed supply and no owner, mint, pause, blacklist, or transfer-tax hooks.
- `ArcForgeBondingCurve` uses OpenZeppelin `ReentrancyGuard`, `SafeERC20`, caller-provided minimum output, checked arithmetic, and pool-favouring reserve rounding.
- The last pre-graduation buy is capped. Graduation removes virtual liquidity without a modeled spot-price discontinuity and irreversibly sends surplus tokens to the dead-address lock.
- The curve has no liquidity-withdrawal function.
- Factory fee changes affect newly created curves; existing curve fee parameters are immutable.
- V6 FeeVault withdrawals are callable only by its owner, and assets are always sent to the current fee recipient.

### Residual findings

| Severity for mainnet | Finding | Impact / required action |
| --- | --- | --- |
| Resolved on mainnet | Protocol administration temporarily depended on one deployment EOA. | Factory, Registry, FeeVault, and the ORIGIN controller are now controlled by the reviewed 2-of-3 Safe. |
| Resolved in active V6 | Trading fees push the creator share directly during every V5 trade. | V6 accrues creator fees and lets the creator claim to a chosen recipient. Deployed V5 bytecode is unchanged. |
| Resolved in active V6 | `FeeVault.collectFee` is permissionless in the deployed V5 Vault. | V6 authorizes collectors and verifies exact received balances. Deployed V5 bytecode is unchanged. |
| Resolved in V5 | The V4 Factory permits non-canonical supply and creator allocation values within broad bounds. | V5 enforces 1B supply and zero free creator allocation onchain. |
| Resolved in active V6 | V5 has no emergency pause or recovery path. | V6 guardian authority is limited to pausing future launches and optional migrations; it cannot pause sells or move reserves. |
| Low | Fee splitting uses integer base units. | Rounding dust goes to the creator share; totals can differ from an exact 70/30 decimal split by base units. |
| Informational | Graduation locks surplus tokens at `0x000…dEaD` and retains USDC in the curve. | This is permanent by design. There is no DEX migration or LP-token withdrawal in V4. |

## Web and infrastructure residual risks

- RPC providers, Arcscan, IPFS gateways, Redis, wallets, and the Arc network are external dependencies and can be delayed or unavailable. Cached data is labelled and transaction execution still relies on fresh onchain quotes.
- Current upload limits and refresh throttles are application-process controls. A public mainnet deployment also needs edge rate limiting, abuse monitoring, and a durable distributed challenge/rate-limit store.
- The Content Security Policy still permits inline scripts/styles required by the current Next.js setup. A nonce-based CSP is recommended before a high-value production launch.
- `pnpm audit --prod --audit-level high` reported no known production dependency vulnerabilities on the review date. The full audit reported high-severity advisories only in the Hardhat/ESLint development toolchain; these tools are not shipped in the production runtime. Upgrade the development stack when compatible releases remove those transitive advisories.
- Confirmed logs, cache reconciliation, and production health checks reduce stale-state failures. A durable, independently operated reorg-aware indexer remains preferable to process-local caches plus public explorer/RPC fallbacks as volume grows.

## Remaining production assurance work

1. Independent Solidity audit and remediation review by a qualified third party.
2. Reproducible builds and verified source code for every deployed contract.
3. Periodic Safe signer rotation and incident-response exercises.
4. Additional property/fuzz testing and formal or symbolic analysis of curve/graduation invariants.
5. Redundant authenticated RPC, durable reorg-aware indexing, edge rate limiting, alerting, and backups.
6. Legal and compliance review for the intended jurisdictions and mainnet asset flows.
7. Independent review of the exact DEX migration adapter and immutable LP locker against the official Arc Uniswap deployment.
8. A separately reviewed post-migration ORIGIN buyback adapter before DEX buybacks are enabled.

Useful baseline references are the [Solidity security considerations](https://docs.soliditylang.org/en/latest/security-considerations.html) and [OpenZeppelin access-control guidance](https://docs.openzeppelin.com/contracts/5.x/access-control).

## Reporting a vulnerability

Do not publish an exploitable issue before the maintainer has had a reasonable opportunity to investigate. Send a private report to the repository owner with the affected component, prerequisites, reproduction steps, impact, and suggested mitigation. Do not include real secrets or private keys.
