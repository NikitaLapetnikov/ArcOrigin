# ArcOrigin security review

Last reviewed: 2026-07-28

Scope: Solidity contracts, deployment scripts, wallet transaction flows, metadata/IPFS APIs, RPC/indexing, caches, and production web headers.

## Status and limitations

ArcOrigin is a testnet product. This document records an internal engineering review, not an independent audit, certification, bug bounty result, or mainnet approval. Deployed V4 and V5 contracts are immutable: application fixes in this repository do not change their bytecode. Contract-level changes require a new deployment and activation plan.

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

The active Arc Testnet V6 deployment is in a temporary governance transition. Factory, CreatorRegistry, and FeeVault ownership still resolve to the deployment EOA `0x2807…9A42`, while the FeeVault recipient and emergency guardian resolve to the reviewed 2-of-3 Safe. The Timelock is pending owner of all three governed contracts and the exact acceptance batch is scheduled, but its 48-hour delay has not expired. This temporary single-key administration is a high-severity mainnet blocker.

Administrative reach is bounded:

- Factory changes apply only to future curves because each curve snapshots its fees, economics, launch protection, and migration configuration at deployment.
- CreatorRegistry ownership can select the Factory allowed to record new launches.
- FeeVault ownership can rotate the recipient; both owner and recipient may trigger withdrawal, but funds always go to the current recipient.
- Existing V5 curves and launched tokens have no owner, upgrade, pause, mint, blacklist, or reserve-withdraw path.

The repository now includes a reviewed governance preparation path: an exact 2-of-3 Safe is the sole proposer/canceller of a self-administered OpenZeppelin timelock with a minimum 48-hour delay; protocol ownership moves to the timelock; a 2-of-3 Treasury Safe becomes the FeeVault recipient. Deployment, dry-run handoff, exact-address execution, role verification, and operation-calldata scripts fail closed on an invalid Safe policy or role layout.

The Safe signers and threshold have been verified, the Timelock roles have been verified, and the V6 ownership-acceptance batch has been scheduled. No V6 ownership has transferred yet; final execution and post-handoff verification remain required. See [`docs/MAINNET_GOVERNANCE_RUNBOOK.md`](./docs/MAINNET_GOVERNANCE_RUNBOOK.md).

## V6 remediation deployment

The active Arc Testnet V6 stack remediates the main contract findings from this review:

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

V6 has 13 dedicated adversarial/property-oriented tests in addition to the existing suite. It is deployed and active only on Arc Testnet; it is not independently audited or approved for mainnet. The full design and release gate are documented in [`docs/V6_SECURITY_ARCHITECTURE.md`](./docs/V6_SECURITY_ARCHITECTURE.md).

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
| High | Active V6 Factory, Registry, and FeeVault administration temporarily depend on one EOA during the scheduled handoff. | Execute and independently verify the prepared 2-of-3 Safe + 48-hour Timelock handoff before mainnet. |
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
- Confirmed logs are sufficient for the current testnet volume, but mainnet needs a durable, reorg-aware indexer and monitoring rather than process-local caches plus public explorer/RPC fallbacks.

## Mainnet blockers

1. Independent Solidity audit and remediation review by a qualified third party.
2. Reproducible builds and verified source code for every deployed contract.
3. Deploy, exercise, and independently verify the prepared 2-of-3 multisig/timelock administration; complete signer rotation and incident-response drills.
4. Deploy and independently review V6 authorized fee collection, pull-based creator fees, migration boundary, and emergency controls.
5. Property/fuzz testing with a dedicated framework and formal or symbolic analysis of curve/graduation invariants.
6. Redundant authenticated RPC, a durable reorg-aware indexer, edge rate limiting, alerting, and backups.
7. Legal and compliance review for the intended jurisdictions and mainnet asset flows.
8. An audited DEX-specific migration adapter and LP fee locker tested against the exact official Arc deployment.

Useful baseline references are the [Solidity security considerations](https://docs.soliditylang.org/en/latest/security-considerations.html) and [OpenZeppelin access-control guidance](https://docs.openzeppelin.com/contracts/5.x/access-control).

## Reporting a vulnerability

Do not publish an exploitable issue before the maintainer has had a reasonable opportunity to investigate. Send a private report to the repository owner with the affected component, prerequisites, reproduction steps, impact, and suggested mitigation. Do not include real secrets or private keys.
