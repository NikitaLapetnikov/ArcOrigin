# ArcOrigin V6 Internal Security Review

Date: 2026-07-30

Reviewed commit: `27fe355a052e3314e2689ad255b123a9e9ccd236`

Review type: internal engineering security review

Deployment: Arc mainnet (`chainId 5042`)

## Executive summary

The reviewed V6 launch, curve, fee, registry, and Uniswap V3 migration code compiled
from a clean Hardhat state and passed all available contract, indexer, health,
type, lint, and production-build checks.

No confirmed Critical, High, or Medium vulnerability was found in the reviewed
scope. Slither produced 30 heuristic detector results. Every result was manually
triaged; none represents a confirmed exploitable issue in the reviewed deployment.
The six High results are reentrancy heuristics on entry points protected by
OpenZeppelin `nonReentrant`, with atomic balance and binding checks after external
calls.

The seven deployed V6 and migration contracts have exact runtime-bytecode matches
against the clean local build and verified source code in Arc Blockscout. Arc USDC
and the four configured Uniswap V3 dependencies also match the pinned runtime
bytecode hashes.

## Conclusion

The internal review supports keeping the current deployment and prepared migration
configuration. It does **not** replace an independent audit and must not be
represented as one.

Mainnet migrations and launches remain paused at the time of this report. Enabling
either requires a transaction from the reviewed 2-of-3 governance Safe. The
repository's mainnet release gate correctly remains blocked because
`independentAuditApproved` is false.

## Residual risks

1. **Independent-review risk.** The same engineering environment authored and
   reviewed the code. A separate auditor may identify assumptions this review
   missed.
2. **Governance execution risk.** Factory, FeeVault, and Registry are directly
   controlled by a 2-of-3 Safe without an active timelock. Two owners can change
   bounded parameters, pause/resume, or replace the migration tuple.
3. **Fresh-pool availability risk.** An attacker can pre-create the canonical
   token/USDC Uniswap V3 pool and deny migration for that token. Funds are not
   redirected: migration reverts atomically and the internal permanent AMM remains
   usable.
4. **External dependency risk.** The migration path depends on the pinned Arc
   USDC and Uniswap V3 contracts. Runtime hashes were verified at the recorded
   block, but ecosystem and operational risks remain outside ArcOrigin's control.
5. **Operational/indexer risk.** Onchain safety does not guarantee uninterrupted
   RPC, indexer, metadata, frontend, Safe, or monitoring availability.

## Package contents

- [SCOPE.md](./SCOPE.md) — exact reviewed files, deployments, and hashes.
- [INVARIANTS.md](./INVARIANTS.md) — critical properties and verification evidence.
- [AUTOMATED-ANALYSIS.md](./AUTOMATED-ANALYSIS.md) — commands, results, and Slither triage.
- [MAINNET-ACTIVATION.md](./MAINNET-ACTIVATION.md) — current live state and safe activation procedure.
