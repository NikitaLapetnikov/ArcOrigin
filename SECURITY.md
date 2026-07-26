# ArcOrigin security review

Last reviewed: 2026-07-26

Scope: Solidity contracts, deployment scripts, wallet transaction flows, metadata/IPFS APIs, RPC/indexing, caches, and production web headers.

## Status and limitations

ArcOrigin is a testnet product. This document records an internal engineering review, not an independent audit, certification, bug bounty result, or mainnet approval. Deployed V4 and V5 contracts are immutable: application fixes in this repository do not change their bytecode. Contract-level changes require a new deployment and activation plan.

Review work included manual source analysis, economic-invariant analysis, contract compilation/tests, TypeScript and ESLint checks, production build verification, and dependency auditing. It did not include formal verification, a professional third-party audit, or exhaustive adversarial testing.

## Review result

No direct unauthorized-withdrawal path or reserve-drain path was found in the reviewed V4 launch, buy, sell, graduation, or FeeVault withdrawal flows.

The web application and indexer were hardened during this review:

- quotes accept only a bounded `uint256` amount and a curve emitted by the configured active Factory;
- confirmed trade UI updates decode the actual receipt event instead of reusing a pre-trade quote;
- forced market refreshes read the latest block, and headline reserves/price come from contract state at that block;
- holder indexing falls back to RPC when Arcscan unexpectedly returns an empty result;
- fee analytics derive launch fees from the Factory and protocol fees from known curve `FeeSplit` events, so arbitrary `FeeVault.collectFee` calls cannot spoof displayed categories;
- metadata upload requests are same-origin, size-bounded, one-time-signature authorized, rate-limited, and memory-bounded;
- token names are validated against the Factory's 64-byte limit and control characters are rejected;
- metadata uploaded by one wallet is never reused after switching to another wallet;
- duplicate launch submissions are blocked in the client;
- RPC, Arcscan, IPFS, and image origins are explicitly constrained by the production Content Security Policy;
- public refresh paths are cached, deduplicated, and throttled to reduce RPC exhaustion.

The Solidity suite currently covers fixed supply, allocation and metadata bounds, access control, fee changes, fee splitting, slippage, dust rounding, randomized reserve invariants, graduation input caps, price continuity, permanent-liquidity solvency, FeeVault withdrawal rules, and timelocked governance execution.

## Administrative access review

The current Arc Testnet deployment is not yet governed by a multisig. Factory, CreatorRegistry, FeeVault ownership, and the FeeVault recipient all resolve to the deployment EOA `0x2807…9A42`. This is acceptable only for the current testing phase and is a high-severity mainnet blocker.

Administrative reach is bounded:

- Factory changes apply only to future curves because each curve snapshots its fees, economics, launch protection, and migration configuration at deployment.
- CreatorRegistry ownership can select the Factory allowed to record new launches.
- FeeVault ownership can rotate the recipient; both owner and recipient may trigger withdrawal, but funds always go to the current recipient.
- Existing V5 curves and launched tokens have no owner, upgrade, pause, mint, blacklist, or reserve-withdraw path.

The repository now includes a reviewed governance preparation path: an exact 2-of-3 Safe is the sole proposer/canceller of a self-administered OpenZeppelin timelock with a minimum 48-hour delay; protocol ownership moves to the timelock; a 2-of-3 Treasury Safe becomes the FeeVault recipient. Deployment, dry-run handoff, exact-address execution, role verification, and operation-calldata scripts fail closed on an invalid Safe policy or role layout.

No ownership has been transferred yet. The final signer addresses must be selected and tested first. See [`docs/MAINNET_GOVERNANCE_RUNBOOK.md`](./docs/MAINNET_GOVERNANCE_RUNBOOK.md).

## V5 changes

V5 narrows the Factory to a canonical one-billion supply and zero free creator allocation, reduces the launch fee to 10 USDC, and snapshots launch protection, curve economics, fees, and any DEX migration adapter into each new curve. The initial protection window limits a wallet to 5% holdings and 5.5% cumulative purchases for three blocks.

The external migration boundary is deliberately disabled on Arc Testnet. A curve configured without an adapter retains the permanent internal AMM behavior. A curve configured with an adapter requires graduation to atomically transfer every remaining token and real-USDC reserve; a zero pool address or any residual curve balance reverts the entire migration. Trading on a successfully migrated curve is permanently disabled.

This boundary does not make an unknown adapter safe. A production Uniswap or Aerodrome adapter and its LP fee locker remain separate mainnet deliverables requiring official Arc deployment addresses, fork tests, source verification, and an independent audit. Adapter configuration is snapshotted at launch and cannot be retrofitted onto an existing curve.

## Contract observations

### Safeguards present

- `ArcForgeToken` has fixed supply and no owner, mint, pause, blacklist, or transfer-tax hooks.
- `ArcForgeBondingCurve` uses OpenZeppelin `ReentrancyGuard`, `SafeERC20`, caller-provided minimum output, checked arithmetic, and pool-favouring reserve rounding.
- The last pre-graduation buy is capped. Graduation removes virtual liquidity without a modeled spot-price discontinuity and irreversibly sends surplus tokens to the dead-address lock.
- The curve has no liquidity-withdrawal function.
- Factory fee changes affect newly created curves; existing curve fee parameters are immutable.
- FeeVault withdrawals are callable only by its owner or current fee recipient, and assets are always sent to the current fee recipient.

### Residual findings

| Severity for mainnet | Finding | Impact / required action |
| --- | --- | --- |
| High | Factory, Registry, and FeeVault administration and the FeeVault recipient currently depend on one EOA on testnet. | Execute and independently verify the prepared 2-of-3 Safe + 48-hour timelock handoff before mainnet. |
| Medium | Trading fees push the creator share directly during every trade. | A future quote token with transfer restrictions, or a blocked creator recipient, could make that token's trades revert. A future V6 design should accrue creator fees for pull-based withdrawal. |
| Medium | `FeeVault.collectFee` is permissionless by design. | Funds cannot be stolen through it, but callers can create real deposits with arbitrary labels. The application now ignores those labels and derives analytics from trusted Factory/curve events. A future V6 Vault should authorize collectors if canonical onchain categories are required. |
| Resolved in V5 | The V4 Factory permits non-canonical supply and creator allocation values within broad bounds. | V5 enforces 1B supply and zero free creator allocation onchain. |
| Medium | There is no emergency pause or recovery path. | This reduces administrator power but also removes incident containment. Decide and document the mainnet governance/fail-safe model before deployment. |
| Low | Fee splitting uses integer base units. | Rounding dust goes to the creator share; totals can differ from an exact 70/30 decimal split by base units. |
| Informational | Graduation locks surplus tokens at `0x000…dEaD` and retains USDC in the curve. | This is permanent by design. There is no DEX migration or LP-token withdrawal in V4. |

## Web and infrastructure residual risks

- RPC providers, Arcscan, IPFS gateways, Redis, wallets, and the Arc network are external dependencies and can be delayed or unavailable. Cached data is labelled and transaction execution still relies on fresh onchain quotes.
- Current upload limits and refresh throttles are application-process controls. A public mainnet deployment also needs edge rate limiting, abuse monitoring, and a durable distributed challenge/rate-limit store.
- The Content Security Policy still permits inline scripts/styles required by the current Next.js setup. A nonce-based CSP is recommended before a high-value production launch.
- `pnpm audit --prod --audit-level high` reported no known production dependency vulnerabilities on the review date. The full audit reported high-severity advisories only in the Hardhat/ESLint development toolchain; these tools are not shipped in the production runtime. Upgrade the development stack when compatible releases remove those transitive advisories.
- Confirmed logs are sufficient for the current testnet volume, but mainnet needs a durable, reorg-aware indexer and monitoring rather than process-local caches plus public explorer/RPC fallbacks.

## Mainnet blockers

1. Independent Solidity audit and remediation review by a qualified third party.
2. Reproducible builds and verified source code for every deployed contract.
3. Deploy, exercise, and independently verify the prepared 2-of-3 multisig/timelock administration; complete signer rotation and incident-response drills.
4. Authorized FeeVault collectors, pull-based creator fees, and a documented emergency-control policy. V5 resolves canonical launch parameters but not these remaining items.
5. Property/fuzz testing with a dedicated framework and formal or symbolic analysis of curve/graduation invariants.
6. Redundant authenticated RPC, a durable reorg-aware indexer, edge rate limiting, alerting, and backups.
7. Legal and compliance review for the intended jurisdictions and mainnet asset flows.
8. An audited DEX-specific migration adapter and LP fee locker tested against the exact official Arc deployment.

Useful baseline references are the [Solidity security considerations](https://docs.soliditylang.org/en/latest/security-considerations.html) and [OpenZeppelin access-control guidance](https://docs.openzeppelin.com/contracts/5.x/access-control).

## Reporting a vulnerability

Do not publish an exploitable issue before the maintainer has had a reasonable opportunity to investigate. Send a private report to the repository owner with the affected component, prerequisites, reproduction steps, impact, and suggested mitigation. Do not include real secrets or private keys.
