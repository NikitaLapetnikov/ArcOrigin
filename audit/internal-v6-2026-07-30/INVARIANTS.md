# Critical invariants

## Launch and supply

1. Every Factory launch mints exactly `1,000,000,000e18` fixed-supply tokens.
2. The creator receives no free token allocation; the complete supply funds the
   launch's canonical curve.
3. Only the one-time-bound CurveDeployer can deploy the canonical V6 curve for the
   Factory.
4. Name, symbol, metadata length, fee, trading fee, launch protection, and
   pagination values are bounded.
5. A launch either completes all deployment, registration, funding, and fee
   operations or reverts atomically.

Evidence: canonical-launch, invalid-configuration, fake-fee, two-step-ownership,
fee-on-transfer, pagination, and randomized V6 tests.

## Curve accounting and trading

1. `tokenReserve` and `usdcReserve` never exceed the curve's actual accounted
   balances.
2. Unsupported fee-on-transfer behavior reverts before accounting can diverge.
3. Buys and sells are deadline- and minimum-output-bounded.
4. Pre-graduation buys cannot pass the graduation cap or drain the token reserve.
5. The constant-product invariant is non-decreasing across tested randomized
   sequences, including integer-rounding paths.
6. Creator fees use pull accounting. A blocked creator address cannot stop other
   users from trading.
7. Protocol fees can only reach the authorized FeeVault through real token
   transfers.
8. Donation dust is excluded from migration amounts and cannot inflate accounted
   reserves.

Evidence: V6 deadline/slippage, restricted-USDC, fee-on-transfer, donation-dust,
creator-fee, and randomized-invariant tests.

## Graduation and migration

1. Graduation succeeds while migration is paused and leaves the internal permanent
   AMM usable.
2. Migration is permissionless only after graduation and only while the exact
   Factory-approved configuration hash is active.
3. Adapter, locker, and verifier runtime code hashes are snapshotted into each
   curve and checked before migration.
4. The adapter accepts only a Factory-recorded canonical curve with matching
   token, creator, reserve, controller, locker, and graduation state.
5. An existing V3 pool causes an atomic revert; it cannot redirect funds.
6. At least 99.90% of both principal assets must be used by the minted V3
   position. Dust is transferred to the permanent locker.
7. The LP NFT is minted directly to the immutable locker. The locker exposes no
   NFT transfer, liquidity removal, burn, rescue, owner, or upgrade path.
8. The verifier checks pool identity, initial price, token order, fee tier, full
   range ticks, position owner, liquidity, principal, and immutable bindings.
9. The curve zeroes reserves and disables internal trading only after adapter and
   verifier success. Any failure rolls back the entire transaction.
10. Collected V3 fees are split 70% to the immutable creator recipient and 30% to
    the canonical FeeVault.

Evidence: permanent-migration, fee-split, unauthorized-source, pre-created-pool,
malicious-adapter, code-hash, tuple-revocation, and diversion-rejection tests.

## Governance and emergency control

1. Factory, FeeVault, and Registry ownership is held by the reviewed 2-of-3 Safe.
2. Ownership transfer is two-step and renunciation is disabled for the mutable
   governance contracts.
3. CurveDeployer is permanently bound to the Factory and its ownership is
   renounced.
4. The emergency guardian can pause launches and migrations but cannot unpause,
   replace configuration, change fees, or withdraw funds.
5. Replacing or disabling the migration tuple automatically pauses migrations and
   revokes every previous configuration hash.
6. FeeVault withdrawals always go to the configured Safe recipient and require
   governance authorization.

Evidence: live ownership/wiring checks and V6 ownership, guardian, tuple-revocation,
and FeeVault authorization tests.
