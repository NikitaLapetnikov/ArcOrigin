# Automated analysis and triage

## Toolchain

- Node.js `v22.22.3`
- Hardhat `2.28.6`
- Solidity `0.8.24` configuration, EVM target `paris`
- Slither `0.11.6`
- TypeScript `5.9.3`
- Next.js `15.5.21`

## Executed checks

```text
hardhat clean
hardhat compile --config hardhat.config.cjs
hardhat test --config hardhat.config.cjs
node --test scripts/test-indexer-resilience.cjs
node --test scripts/test-production-health.cjs
tsc --noEmit
eslint .
next build
slither . --compile-force-framework hardhat --hardhat-ignore-compile \
  --exclude-dependencies --filter-paths <legacy-and-mock-filter>
hardhat run scripts/verify-v6-candidate.cjs --network arcMainnet
hardhat run scripts/verify-mainnet-sources.cjs --network arcMainnet
node scripts/verify-mainnet-network.cjs
hardhat run scripts/check-mainnet-readiness.cjs --network arcMainnet
```

## Results

| Check | Result |
|---|---|
| Clean Solidity compile | PASS — 65 files |
| Solidity/Hardhat tests | PASS — 47/47 |
| Indexer resilience tests | PASS — 7/7 |
| Production-health tests | PASS — 4/4 |
| TypeScript | PASS |
| ESLint | PASS |
| Next.js production build | PASS — 15 pages/routes generated |
| V6 deployed runtime match | PASS — Factory, Vault, Registry, CurveDeployer |
| Migration runtime/source verification | PASS — Adapter, Locker, Verifier |
| Arc USDC/Uniswap runtime hashes | PASS |
| Safe ownership/wiring | PASS — reviewed 2-of-3 |
| Mainnet release gate | BLOCKED — independent audit approval is false |

## Slither output

Slither analyzed 70 contracts after dependencies, mocks, and legacy contracts were
filtered from reported source paths. It produced 30 detector results:

| Detector | Severity | Count | Triage |
|---|---:|---:|---|
| `reentrancy-balance` | High | 6 | False positive / mitigated |
| `reentrancy-no-eth` | Medium | 2 | False positive / mitigated |
| `reentrancy-benign` | Low | 4 | False positive / mitigated |
| `divide-before-multiply` | Medium | 2 | Intended tick alignment |
| `incorrect-equality` | Medium | 5 | Intentional exact asset/protocol validation |
| `uninitialized-local` | Medium | 2 | Solidity zero-initialized memory structs |
| `unused-return` | Medium | 4 | Unneeded tuple fields intentionally omitted |
| `timestamp` | Low | 5 | Intended deadline/cooldown semantics |

### Reentrancy results

The High findings target:

- `ArcForgeBondingCurveV6.migrateToDex`
- `ArcOriginUniswapV3LiquidityLocker._collectPositionFees`
- `ArcOriginBuybackController.executeBuyback`

All public entry points are protected by OpenZeppelin `nonReentrant`. Migration
dependencies are immutable or code-hash pinned, adapter/locker/controller bindings
are revalidated, expected balance deltas are checked, and a failed postcondition
reverts the complete call. No exploitable reentrant path was confirmed.

`ArcForgeBondingCurveV6.buy` and `ArcForgeFactoryV6.launchToken` are likewise
`nonReentrant`; the flagged writes occur within an all-or-nothing transaction.

### Arithmetic and equality results

`usableTicks` intentionally truncates the minimum tick toward zero and the maximum
tick downward, producing the closest valid full-range tick multiples inside the
Uniswap V3 global tick bounds. For the configured 1% pool, the result uses spacing
`200`.

Exact equality checks are deliberate defenses against fee-on-transfer assets,
partial pulls, unexpected Uniswap results, residual adapter balances, and changed
protocol bindings. Relaxing them would weaken accounting safety.

### Uninitialized and unused tuple fields

The two memory structs are deterministically zero-initialized by Solidity before
their fields are assigned. Ignored tuple outputs are values the protocol does not
need; every security-relevant position and pool field is read and validated.

## Manual-review outcome

Confirmed findings requiring a source fix:

- Critical: 0
- High: 0
- Medium: 0
- Low: 0

Documented design/operational risks are listed in the package README. “No confirmed
finding” is not a guarantee that no vulnerability exists.
