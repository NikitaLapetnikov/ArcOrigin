# Mainnet migration activation

## Live state at review time

- Arc mainnet chain ID: `5042`
- Factory: `0x2dAED890c8920428e0215583aaC98332447a8170`
- Governance Safe: `0xa6eA2380F98700AD5CA8B9F74dC8861269513779`
- Safe threshold: `2`
- Safe owners: `3`
- Launches paused: `true`
- Migrations paused: `true`
- Migration configuration:
  `0x014dab2eb4a6c624beb2d50c873a2792683519bede450c548023758913a0b640`

The migration tuple and its runtime hashes match the deployment manifest and the
Factory's live storage.

## Prepared migration transaction

The repository contains a Safe Transaction Builder batch:

`deployment/v6-mainnet-unpause-migrations.safe.local.json`

It contains exactly one transaction:

| Field | Value |
|---|---|
| To | `0x2dAED890c8920428e0215583aaC98332447a8170` |
| Value | `0` |
| Calldata | `0x9259a3e5` |
| Decoded call | `unpauseMigrations()` |

This transaction changes only `migrationPaused` from `true` to `false`. It does not
unpause launches, change an address, transfer an asset, or modify economics.

## Required Safe procedure

1. Connect one of the three reviewed owner wallets to the ArcOrigin Safe on Arc.
2. Import `deployment/v6-mainnet-unpause-migrations.safe.local.json` in Transaction
   Builder.
3. Confirm the Safe address, chain `5042`, Factory destination, zero value, and
   decoded `unpauseMigrations()` call.
4. Create and sign the Safe proposal.
5. Connect a second reviewed owner and confirm the same transaction.
6. Execute after the 2-of-3 threshold is reached.
7. Record the transaction hash.
8. Run:

   ```text
   V6_ACTIVATION_PHASE=migrations \
   V6_MIGRATION_ACTIVATION_TX_HASH=<transaction-hash> \
   hardhat run scripts/verify-v6-mainnet-activation.cjs \
     --network arcMainnet --config hardhat.config.cjs
   ```

9. Verify the Factory reports `migrationPaused=false` while `paused=true`.

## Launch activation remains separate

Do not combine migration activation with launch activation. The second prepared
batch, `deployment/v6-mainnet-unpause-launches.safe.local.json`, is intentionally
separate so the migration-only state can be verified first.

The complete readiness gate currently reports:

```json
{
  "sourceVerificationConfirmed": true,
  "independentAuditApproved": false,
  "reorgIndexerTested": true,
  "monitoringAlertsTested": true
}
```

Therefore production launch activation remains blocked by the independent-audit
gate. This internal package does not set or bypass that gate.
