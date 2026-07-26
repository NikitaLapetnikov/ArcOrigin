# ArcOrigin security review

Last reviewed: 2026-07-26

Scope: Solidity contracts, deployment scripts, wallet transaction flows, metadata/IPFS APIs, RPC/indexing, caches, and production web headers.

## Status and limitations

ArcOrigin is a testnet product. This document records an internal engineering review, not an independent audit, certification, bug bounty result, or mainnet approval. The deployed V4 contracts are immutable: application fixes in this repository do not change their bytecode. Contract-level changes require a new deployment and migration plan.

Review work included manual source analysis, economic-invariant analysis, contract compilation/tests, TypeScript and ESLint checks, production build verification, and dependency auditing. It did not include formal verification, a professional third-party audit, or exhaustive adversarial testing.

## Review result

No direct unauthorized-withdrawal path or reserve-drain path was found in the reviewed V4 launch, buy, sell, graduation, or FeeVault withdrawal flows.

The web application and indexer were hardened during this review:

- quotes accept only a bounded `uint256` amount and a curve emitted by the configured V4 Factory;
- confirmed trade UI updates decode the actual receipt event instead of reusing a pre-trade quote;
- forced market refreshes read the latest block, and headline reserves/price come from contract state at that block;
- holder indexing falls back to RPC when Arcscan unexpectedly returns an empty result;
- fee analytics derive launch fees from the Factory and protocol fees from known V4 curve `FeeSplit` events, so arbitrary `FeeVault.collectFee` calls cannot spoof displayed categories;
- metadata upload requests are same-origin, size-bounded, one-time-signature authorized, rate-limited, and memory-bounded;
- token names are validated against the Factory's 64-byte limit and control characters are rejected;
- metadata uploaded by one wallet is never reused after switching to another wallet;
- duplicate launch submissions are blocked in the client;
- RPC, Arcscan, IPFS, and image origins are explicitly constrained by the production Content Security Policy;
- public refresh paths are cached, deduplicated, and throttled to reduce RPC exhaustion.

The Solidity suite currently covers fixed supply, allocation and metadata bounds, access control, fee changes, fee splitting, slippage, dust rounding, randomized reserve invariants, graduation input caps, price continuity, permanent-liquidity solvency, and FeeVault withdrawal rules.

## V4 contract observations

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
| High | Factory, Registry, and FeeVault administration currently depends on a single EOA on testnet. | Move ownership to a reviewed multisig and put fee/configuration changes behind a timelock before mainnet. |
| Medium | Trading fees push the creator share directly during every trade. | A future quote token with transfer restrictions, or a blocked creator recipient, could make that token's trades revert. A V5 design should accrue creator fees for pull-based withdrawal. |
| Medium | `FeeVault.collectFee` is permissionless by design. | Funds cannot be stolen through it, but callers can create real deposits with arbitrary labels. The application now ignores those labels and derives analytics from trusted Factory/curve events. A V5 Vault should authorize collectors if canonical onchain categories are required. |
| Medium | The Factory permits non-canonical supply and creator allocation values within broad bounds. | The ArcOrigin UI creates 1B-supply, zero-free-allocation launches, but direct Factory callers can choose other valid values. A canonical mainnet factory should enforce the intended economics onchain. |
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
3. Multisig ownership, delayed administration, signer rotation, and an incident-response runbook.
4. A V5 decision for authorized fee collectors, pull-based creator fees, canonical launch parameters, and emergency controls.
5. Property/fuzz testing with a dedicated framework and formal or symbolic analysis of curve/graduation invariants.
6. Redundant authenticated RPC, a durable reorg-aware indexer, edge rate limiting, alerting, and backups.
7. Legal and compliance review for the intended jurisdictions and mainnet asset flows.

Useful baseline references are the [Solidity security considerations](https://docs.soliditylang.org/en/latest/security-considerations.html) and [OpenZeppelin access-control guidance](https://docs.openzeppelin.com/contracts/5.x/access-control).

## Reporting a vulnerability

Do not publish an exploitable issue before the maintainer has had a reasonable opportunity to investigate. Send a private report to the repository owner with the affected component, prerequisites, reproduction steps, impact, and suggested mitigation. Do not include real secrets or private keys.
