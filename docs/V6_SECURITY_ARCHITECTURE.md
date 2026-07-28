# ArcOrigin V6 security architecture

Status: active on Arc Testnet after bytecode verification and onchain exercises. Governance handoff is scheduled but incomplete, and the deployment is not independently audited.

V6 is a new, isolated contract stack. It does not modify any deployed V4 or V5 bytecode. Arc Testnet was activated early with explicit acceptance of the temporary single-key administrator risk while the already-scheduled Timelock delay completes. This exception is not a mainnet precedent: mainnet activation still requires an independently reviewed governance handoff, frontend compatibility testing, a full exercise, and an independent audit.

## Security objectives

V6 is designed around these invariants:

1. A failed or malicious optional DEX migration cannot block graduation.
2. A curve can migrate only its internally accounted reserves.
3. Unsolicited token or USDC transfers cannot alter curve accounting or prevent migration.
4. Trading fees cannot be blocked by a restricted creator recipient.
5. Only canonical Factory and curve contracts can create FeeVault accounting events.
6. The Treasury recipient cannot bypass governance to withdraw the FeeVault.
7. Emergency authority can stop new launches and optional migrations, but cannot seize reserves, change prices, mint tokens, or block sells.
8. Existing curve economics remain immutable.

## Contracts

### `ArcForgeFactoryV6`

- Deploys a canonical fixed supply of one billion tokens with zero free creator allocation.
- Validates 6-decimal quote assets and rejects launch-fee transfer mismatches.
- Caps launch fees at 100 USDC and trading fees at 2%.
- Uses bounded pagination instead of returning unbounded launch arrays.
- Supports an immediate emergency guardian that may only pause new launches or optional migrations.
- Only governance may resume operations, change the guardian, change future economics, or configure migration.
- Uses `Ownable2Step`; ownership renunciation is disabled.
- A newly configured migration tuple starts paused and automatically revokes every older tuple.

### `ArcForgeCurveDeployerV6`

The deployer separates curve creation bytecode from Factory runtime to stay safely below EIP-170. It can be bound to exactly one Factory. Binding permanently removes its owner, so no later account can replace the Factory.

### `ArcForgeBondingCurveV6`

- Uses constant-product pricing, pool-favouring rounding, `SafeERC20`, `ReentrancyGuard`, minimum output, and transaction deadlines.
- Rejects quote/token transfers when the received amount differs from the declared amount.
- Accrues the creator's 70% fee share inside the curve. The creator explicitly claims to a chosen recipient.
- Sends the protocol's 30% share to the authorized V6 FeeVault.
- Graduation always activates the permanent internal real-reserve AMM first.
- Optional DEX migration is a separate transaction after graduation. A failure leaves the AMM and all state usable.
- Migration compares exact before/after balance deltas with accounted reserves. Extra donations remain separate and cannot block the operation.
- Adapter, locker, and verifier addresses plus their runtime code hashes are snapshotted at launch.
- Migration requires the Factory controller to still approve the exact configuration hash.
- An independent DEX-specific verifier must confirm canonical pool and locker state before the curve disables internal trading.
- The curve has no owner, upgrade, mint, blacklist, arbitrary pause, or reserve-withdraw function.

### `ArcForgeFeeVaultV6`

- Accepts fees only from owner-approved collectors or curves registered by an approved Factory.
- Verifies exact token balance changes when collecting fees.
- Only its owner may withdraw; the configured recipient cannot trigger a withdrawal and bypass the timelock.
- Every withdrawal always goes to the visible `feeRecipient`.
- Uses `Ownable2Step`; ownership renunciation is disabled.

### `ArcForgeCreatorRegistryV6`

- Accepts launch records only from the active Factory.
- Bounds creator metadata URIs to 512 bytes.
- Requires the selected Factory to contain contract code.
- Uses `Ownable2Step`; ownership renunciation is disabled.

## Graduation and migration state machine

```text
Pre-graduation curve
        |
        | threshold reached
        v
Permanent internal AMM
  - price continuity retained
  - buys and sells remain live
  - migration failure cannot affect graduation
        |
        | optional, permissionless migrateToDex()
        | exact tuple approved + unpaused
        | code hashes unchanged
        | exact reserve deltas
        | independent verifier returns true
        v
Verified external pool + locked position
  - internal trading permanently disabled
  - pending creator fees remain claimable
```

Migration should remain disabled when no audited DEX-specific adapter, locker, and verifier exist. The generic boundary cannot prove correctness of an unknown DEX by itself.

## Governance model

Recommended mainnet layout:

- Governance Safe: exactly 2-of-3 independent hardware-backed signers.
- Timelock: self-administered, minimum 48–72 hours, Governance Safe as sole proposer/canceller, open execution after delay.
- Treasury Safe: exactly 2-of-3, configured as FeeVault recipient.
- Factory, FeeVault, and CreatorRegistry owner: Timelock.
- Emergency guardian: a reviewed Safe that can only pause launches and migrations.

V6 uses two-step ownership. The deployer first sets the Timelock as `pendingOwner`; the Timelock later executes a scheduled batch of `acceptOwnership()` calls. Until that batch executes, ownership remains with the deployer. Never describe a pending handoff as completed.

## Deployment gate

Required before activation:

1. `pnpm contracts:compile`
2. `pnpm contracts:test`
3. Static analysis with all warnings manually triaged.
4. Deploy V6 as an isolated candidate; keep migration disabled and paused.
5. `pnpm verify:arc-testnet:v6` for exact runtime bytecode and wiring.
6. Execute the two-step Safe/Timelock handoff and verify final owners.
7. Launch and trade multiple Testnet tokens, including graduation and creator fee claims.
8. Independently review the deployed source, compiler settings, transactions, Safe owners, Timelock roles, and manifest.
9. Obtain an independent audit and remediation review.
10. Only when a real Arc DEX exists: add an audited DEX-specific adapter, locker, and independent verifier; run fork tests against the exact deployment.

## Tests included

The V6 suite covers:

- canonical launch supply and collector registration;
- unauthorized FeeVault events and withdrawal bypass attempts;
- two-step governance transfers for Factory, FeeVault, and CreatorRegistry;
- pull-based creator fee claims and alternate claim recipients;
- quote-token restrictions on the creator address;
- deadlines, slippage, and governance parameter caps;
- fee-on-transfer rejection;
- graduation while migration is paused;
- post-graduation internal trading;
- token and USDC donation dust during migration;
- an adapter that attempts to steal every reserve;
- emergency guardian boundaries;
- migration tuple revocation;
- randomized post-graduation reserve and invariant checks.

These tests are necessary but do not constitute formal verification or an independent audit.

## Static-analysis triage

Slither was run against the V6 contracts after a clean Hardhat compilation. Its remaining
reports were reviewed rather than silently suppressed:

- `reentrancy-balance`, `reentrancy-no-eth`, and `reentrancy-benign` point to the external
  FeeVault and migration-adapter calls. Every state-changing Curve and Factory entry point
  containing those calls is protected by `ReentrancyGuard`; a callback cannot re-enter a
  mutating path. Migration also verifies exact balance deltas and the independently verified
  result before committing state, and any failure reverts the complete transaction.
- `timestamp` points only to user-supplied transaction deadlines. These deliberately protect
  quotes from delayed inclusion and do not determine pricing or governance authority.
- `missing-inheritance` incorrectly reports that `ArcForgeFeeVaultV6` should inherit
  `IArcForgeFeeVaultV6`; the inheritance is already explicit in the contract declaration.

The reviewed warnings are tool heuristics, not proof of safety. They must be re-evaluated if
the adapter, verifier, locker, quote token, or compiler configuration changes.
