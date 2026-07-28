# ArcOrigin mainnet governance runbook

Status: preparation only. No Safe or timelock address is configured in the public deployment manifest yet.

This runbook does not replace an independent smart-contract audit. Do not transfer production ownership until every address, signer, bytecode deployment, and role assignment has been independently reviewed.

## Target administration model

```text
Three independent signer wallets
            │
            │ 2 signatures required
            ▼
Governance Safe (2-of-3)
            │
            │ sole proposer + canceller
            ▼
48-hour self-administered Timelock
            │
            ├── owns active Factory
            ├── owns CreatorRegistry
            ├── owns FeeVault
            └── owns legacy Factories

Treasury Safe (2-of-3)
            ▲
            └── FeeVault feeRecipient
```

The Governance Safe cannot call protocol owner functions directly. It can only schedule an exact operation in the timelock. Anyone may execute that already-approved operation after 48 hours; public execution does not permit changing its target, calldata, value, or salt.

The Treasury Safe may be the same 2-of-3 Safe initially, but a separate treasury Safe reduces operational coupling. Both Safes must use three distinct owners and a threshold of two.

## Signer requirements

- Use three distinct addresses controlled through independent devices or people.
- Do not derive multiple signers from one seed phrase.
- Prefer hardware-backed signers; keep recovery material offline and geographically separated.
- Test every signer on Arc Testnet before any ownership transfer.
- Record signer purpose, device, backup custodian, and rotation procedure privately.
- Never put private keys or seed phrases in this repository, `.env`, chat, screenshots, or deployment output.

## Administrative power after handoff

| Component | Timelocked action | Scope |
| --- | --- | --- |
| V5 Factory | launch fee, future curve fees/economics/protection, future migration adapter | Future launches only; existing curve snapshots remain immutable |
| CreatorRegistry | active Factory address | Determines which Factory may record new launches |
| FeeVault | fee recipient | Changes where future withdrawals are sent |
| FeeVault recipient | withdraw Vault assets | Requires the Treasury Safe threshold but not the governance timelock |
| Existing curves | none | No owner, pause, upgrade, or reserve-withdraw function |
| Launch tokens | none | Fixed supply; no owner, mint, blacklist, pause, or transfer tax |

The current V5 contracts have no emergency pause. A compromised or faulty external dependency cannot be contained by pausing existing curves. Before mainnet, decide whether a narrowly scoped, timelocked-by-default emergency guardian belongs in a separately audited V6.

The undeployed V6 candidate implements that narrower model: a reviewed guardian Safe may stop only new launches and optional migrations. It cannot resume either function, change parameters, pause sells, migrate funds, or withdraw reserves. Only the Timelock owner can resume or reconfigure the protocol.

## Phase 1 — create and verify Safes

1. Confirm Safe contracts are officially deployed and source-verified on the exact Arc network.
2. Create the Governance Safe with the three final signer addresses and threshold `2`.
3. Create a separate Treasury Safe with three owners and threshold `2`, or explicitly approve using the Governance Safe for both roles.
4. Execute a harmless test transaction requiring two signatures on Arc Testnet.
5. Verify `getOwners()` and `getThreshold()` onchain. Do not rely only on the Safe web interface.

Safe recommends a threshold greater than one; ArcOrigin scripts intentionally require exactly 2-of-3.

## Phase 2 — deploy the timelock

Set only public addresses and the deployer key in the local environment:

```bash
GOVERNANCE_SAFE=0x... \
TIMELOCK_DELAY_SECONDS=172800 \
pnpm governance:deploy:arc-testnet
```

The deployment script rejects:

- an EOA or undeployed Safe address;
- anything other than a 2-of-3 Safe;
- a delay below 48 hours;
- duplicate Safe owners.

The deployed `ArcOriginGovernanceTimelock` grants:

- `PROPOSER_ROLE` to the Governance Safe only;
- `CANCELLER_ROLE` to the Governance Safe only;
- open `EXECUTOR_ROLE` to `address(0)`;
- `DEFAULT_ADMIN_ROLE` to the timelock itself only.

Neither the deployer nor the Safe receives direct admin authority over the timelock.

## Phase 3 — dry-run the ownership handoff

```bash
GOVERNANCE_SAFE=0x... \
TREASURY_SAFE=0x... \
GOVERNANCE_TIMELOCK=0x... \
pnpm governance:handoff:arc-testnet
```

Dry-run is the default. It validates Safe policies, deployed bytecode, timelock roles, current owners, the active Factory, every legacy Factory, CreatorRegistry, FeeVault, and the intended fee recipient. It sends no transactions.

Have a second person compare every printed address against:

- the Safe UI and onchain Safe getters;
- the timelock deployment transaction;
- the checked-in deployment manifest;
- Arcscan source and bytecode.

## Phase 4 — execute on Arc Testnet

Only after the dry-run is independently approved:

```bash
GOVERNANCE_SAFE=0x... \
TREASURY_SAFE=0x... \
GOVERNANCE_TIMELOCK=0x... \
EXECUTE_ADMIN_HANDOFF=true \
CONFIRM_ADMIN_HANDOFF=0xExactTimelockAddress \
pnpm governance:handoff:arc-testnet
```

The script is resumable. It updates the FeeVault recipient, transfers legacy Factory ownership, then active Factory, FeeVault, and CreatorRegistry ownership. It verifies every final owner before updating the deployment manifest.

These deployed contracts use one-step `Ownable.transferOwnership`. A wrong address can permanently lock administration. The exact-address confirmation is intentional and must not be removed.

### V6 two-step handoff

V6 Factory, FeeVault, and CreatorRegistry use `Ownable2Step`. Do not use the V5 one-step handoff command for them.

First dry-run the V6 checks:

```bash
GOVERNANCE_SAFE=0x... \
TREASURY_SAFE=0x... \
GOVERNANCE_TIMELOCK=0x... \
pnpm governance:handoff:arc-testnet:v6
```

After independent review, prepare each pending owner and generate one Safe/Timelock batch:

```bash
GOVERNANCE_SAFE=0x... \
TREASURY_SAFE=0x... \
GOVERNANCE_TIMELOCK=0x... \
EXECUTE_V6_HANDOFF_PREPARE=true \
CONFIRM_V6_HANDOFF=0xExactTimelockAddress \
V6_HANDOFF_SALT_LABEL="ArcOrigin V6 Testnet handoff 1" \
pnpm governance:handoff:arc-testnet:v6
```

This first step does **not** transfer ownership. It sets the Timelock as `pendingOwner` and writes exact Safe scheduling and permissionless execution calldata to a gitignored local plan. Ownership changes only after:

1. the Governance Safe schedules the generated batch;
2. the full delay expires;
3. the exact `executeBatch` transaction calls `acceptOwnership()` on all three contracts;
4. every `owner()` and `pendingOwner()` value is independently verified.

The V6 candidate must not be activated while the deployer remains owner.

## Phase 5 — verify and exercise the delay

```bash
pnpm governance:verify:arc-testnet
pnpm verify:arc-testnet
```

Then schedule a harmless, state-preserving operation, such as setting the launch fee to its current value. Build exact Safe calldata:

```bash
GOVERNANCE_TIMELOCK=0x... \
TIMELOCK_TARGET=0xFactory \
TIMELOCK_CALLDATA=0x... \
TIMELOCK_SALT_LABEL="Arc Testnet governance smoke test 1" \
pnpm governance:build-operation:arc-testnet
```

1. Submit the generated `safeScheduleTransaction` from the Governance Safe.
2. Confirm one signer cannot execute it alone.
3. Confirm execution fails before 48 hours.
4. After 48 hours, submit the exact `permissionlessExecuteTransaction`.
5. Confirm the operation ID, target, calldata, salt, receipt, and final state.
6. Test cancellation with a second harmless scheduled operation.

Do not use a real fee or migration change for the first governance test.

## Phase 6 — mainnet release gate

Repeat the process on mainnet only when all of these are complete:

- independent audit and remediation review;
- official Arc mainnet chain, USDC, Safe, explorer, RPC, and DEX addresses;
- verified source and reproducible bytecode for protocol, timelock, adapter, and locker;
- fork tests against the exact DEX deployment;
- durable reorg-aware indexing, alerting, edge rate limits, and backups;
- documented incident communications and signer-rotation drill;
- legal/compliance review;
- at least one complete Testnet timelock schedule/cancel/execute exercise.

## Incident response

- Suspected signer compromise: the other two Safe signers remove/replace it immediately through a Safe transaction.
- Suspicious scheduled operation: Governance Safe cancels it before execution.
- Frontend compromise: disable affected UI actions and publish verified contract addresses; frontend control does not grant contract ownership.
- Factory issue: stop promoting new launches. Existing curves remain immutable. A Registry change still requires the timelock.
- Treasury signer compromise: rotate the signer before new FeeVault withdrawals; if threshold control is lost, no contract-side recovery exists.
- Timelock proposer loss: no new admin operation can be scheduled. This is intentional fail-closed behavior and is why signer recovery must be tested.

## Independent verification commands

```bash
pnpm security:audit-admin:arc-testnet
pnpm governance:verify:arc-testnet
pnpm contracts:test
pnpm typecheck
pnpm lint
pnpm build
```

Keep transaction hashes and final owner/role outputs with the release artifacts. Never describe this internal preparation as a third-party audit.
