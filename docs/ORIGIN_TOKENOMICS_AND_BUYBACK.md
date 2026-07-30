# ORIGIN protocol token and buyback policy

Status: **active on Arc mainnet** since 2026-07-30.

## Canonical deployment

| Component | Address |
| --- | --- |
| ORIGIN token | `0xB65Fd34cc428492DdF000A2Ae100Dbfea62E4802` |
| ORIGIN curve | `0x18708Bd06e264E8147065159C90460be4b5B5312` |
| Buyback controller | `0x43ED0F9CD330FE8F093f2a0CE2FA05A155e7f746` |
| Fee Vault | `0x07287313ee649efcF22EAEE4361cd6c512219B61` |
| Governance / operations Safe | `0xa6eA2380F98700AD5CA8B9F74dC8861269513779` |
| Arc USDC | `0x3600000000000000000000000000000000000000` |

The canonical activation was executed by the 2-of-3 Governance Safe in transaction
`0x1e97a067b2382b2fc345c852538208d52d46471ccdd750e00b0d44bba282ccf0`.
The controller source and constructor arguments are verified in Arc Blockscout. The full
machine-readable record is in `deployment/arc-mainnet.json`.

ORIGIN has a fixed one-billion-token supply, zero free creator allocation, a 10,000 USDC
graduation target, and the same 1% curve trading fee as other V6 launches. The curve records
the launch creator as its immutable creator-fee recipient.

## Revenue flow

Curve trading fees are split onchain: 70% accrues to each token creator and 30% enters the
protocol Fee Vault. Launch fees also enter the Fee Vault. The following governance-controlled
flow applies only to USDC that the Safe withdraws from that vault:

1. the V6 Fee Vault transfers the approved amount only to the configured buyback controller;
2. anyone may call `allocateRevenue()` after the transfer;
3. 80% becomes `pendingBuybackUsdc`;
4. 20% is transferred immediately to the operations Safe;
5. an authorized executor spends bounded slices buying ORIGIN from its V6 curve;
6. every ORIGIN token received is sent directly to
   `0x000000000000000000000000000000000000dEaD`.

Fee Vault withdrawals currently require an explicit 2-of-3 Safe transaction. Revenue allocation
is permissionless, but buyback execution is authorized. The policy is active, not a promise that
withdrawals or purchases occur on any fixed schedule.

If all curve protocol fees are withdrawn and allocated, the effective trading-fee allocation is
0.70% of volume to the token creator, 0.24% to ORIGIN buybacks, and 0.06% to operations.
Launch-fee revenue follows the controller's same 80/20 split.

Sending ORIGIN to the burn address reduces circulating supply. It does not change the immutable
ERC-20 `totalSupply()` value.

## Onchain execution limits

The active controller enforces:

- immutable 80% buyback / 20% operations allocation;
- maximum 25 USDC per execution;
- at least 3,600 seconds between executions;
- maximum 3% execution slippage;
- transaction deadlines no more than 15 minutes ahead;
- output sent only to the canonical burn address;
- no recovery of USDC or ORIGIN by governance;
- pause authority for the Safe, with unpause restricted to the owner;
- owner-only executor and configuration changes through `Ownable2Step`;
- disabled ownership renunciation.

The current executor is `0x2807B95E05649b7Befe74C4061f9492C5b889A42`. Compromise of that
account cannot redirect purchased tokens or withdraw controller funds, but it can choose execution
timing within the configured limits. The Governance Safe can revoke or pause it.

## Migration behavior

The controller buys only through the canonical ORIGIN V6 curve. If that curve migrates to
Uniswap V3, `executeBuyback` fails closed with `TradingMigrated`. No controller funds are spent.
A separately reviewed DEX adapter and Safe activation are required before post-migration buybacks
can resume.

## Operational checklist

Before each buyback batch:

1. reconcile the Fee Vault balance and submit the intended USDC withdrawal through the Safe;
2. confirm the withdrawal recipient is the canonical controller;
3. call `allocateRevenue()` and reconcile `RevenueAllocated`;
4. obtain a fresh curve quote and derive a minimum output within the 3% cap;
5. execute no more than 25 USDC after the one-hour interval;
6. reconcile `BuybackExecuted`, the burn-address balance, pending USDC, and controller totals;
7. alert and pause on unexpected state, stale quotes, RPC disagreement, or accounting drift.

Buybacks and burns do not guarantee price appreciation, trading volume, liquidity, or investment
returns. Never store Safe signer keys, the executor key, RPC credentials, or private API keys in
the repository.
