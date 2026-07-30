# Scope and deployment identity

## Source identity

| File | SHA-256 |
|---|---|
| `contracts/ArcForgeFactoryV6.sol` | `aeb6a6946abe85b6da4d9c56ad1b771aa6ea6af487818e4d36422e694d8883c3` |
| `contracts/ArcForgeBondingCurveV6.sol` | `5abb6aa01ab89e39870e477a67d6709582e5e85dc8c934b57b66fef60c780226` |
| `contracts/ArcForgeFeeVaultV6.sol` | `a3cae7f1e0eea86207b425fe7b4518491665dcea4d5f6f2f6643356f5c177477` |
| `contracts/ArcForgeCreatorRegistryV6.sol` | `f7a86e180a9414402957853cb602a90b1f2bb6ec4eebcf8ac2ffc7b19ba69276` |
| `contracts/ArcForgeCurveDeployerV6.sol` | `ea5ba1386ae3dd4a74d36c3df925a910d7af27e134a57750b214495b8e77dcbd` |
| `contracts/ArcForgeToken.sol` | `d3d83d28dda48bec2568ad7f889ac4da9f6cd730e59f8d1bb5f4c8e028cd37d0` |
| `contracts/uniswap/ArcOriginUniswapV3MigrationAdapter.sol` | `da02b1c0864de073394a48b3b467911a32cb3f7ca4452e3cf6844f99c42fa840` |
| `contracts/uniswap/ArcOriginUniswapV3LiquidityLocker.sol` | `75ad8805037772466a0caa818561d664cff2691dbebd93737551ff7531f1fe98` |
| `contracts/uniswap/ArcOriginUniswapV3MigrationVerifier.sol` | `6ae286eb699e2e41f860764d3b4a380ef3089303e8e521531111a28eaa6d637b` |
| `contracts/uniswap/ArcOriginUniswapV3Math.sol` | `0435e3a33434b031ad94f8ac6fff5bca22096fa5fdff363ce75e842b7b0dea46` |

The AORG buyback controller and former governance timelock were included in
automated analysis and tests but are not part of the active V6 mainnet deployment:

| File | SHA-256 |
|---|---|
| `contracts/ArcOriginBuybackController.sol` | `287b1d3fe405d334192a39342b24d98ba2d138275c26faa107d2db24b43fe105` |
| `contracts/ArcOriginGovernanceTimelock.sol` | `19ca9b16f1b21c2fec4b3a8f0cb2617f5bca893c096fb1dbb0db0cc803a05c03` |

## Arc mainnet deployment

| Component | Address | Runtime verification |
|---|---|---|
| Factory V6 | `0x2dAED890c8920428e0215583aaC98332447a8170` | Exact local match; Blockscout verified |
| FeeVault V6 | `0x07287313ee649efcF22EAEE4361cd6c512219B61` | Exact local match; Blockscout verified |
| CreatorRegistry V6 | `0xA4DbA45B199287d3163199A86B4618968d8f8424` | Exact local match; Blockscout verified |
| CurveDeployer V6 | `0xd7D2e4Ce4548330f52fc2F79F8524E6e32576013` | Exact local match; Blockscout verified |
| MigrationAdapter | `0xc3EF95C4afDe66537acC40011ED5c6e505126a21` | Exact local match; Blockscout verified |
| LiquidityLocker | `0xC41DA72afE97f8fbCA9722f893519cF2972cFb0e` | Exact local match; Blockscout verified |
| MigrationVerifier | `0xAA949a795CB1bCc15E4c1AA2DC18a548b9f483c9` | Exact local match; Blockscout verified |
| Arc USDC | `0x3600000000000000000000000000000000000000` | Pinned runtime hash |
| Governance/Treasury Safe | `0xa6eA2380F98700AD5CA8B9F74dC8861269513779` | 2-of-3 verified onchain |

Migration runtime hashes:

- Adapter: `0x232174875e6c5093ff665b4ae2a2eb9b8dfd05e5535e0c995594f20279ec8407`
- Locker: `0x44c54213b2d82495aa713d72fb30e79564908ba9251308ad77637a345bae2992`
- Verifier: `0x566cc9c49bd0b96a806d33fdc59fcace20fa82e5aa46d7775f46f34dce09d5ee`

## Pinned Uniswap V3 dependencies

Checked at Arc mainnet block `12903325`.

| Component | Address | Runtime hash |
|---|---|---|
| V3 Factory | `0xf0db7b58379503491d857db50ac9ece64c653918` | `0x621c4819f7b62d7ddb153206bc30950bcc3f5cc9d24c45661f8c2f31dcbd166d` |
| PositionManager | `0x39654a85a4c05127f5fd6ed22caec077a0fb1377` | `0xcad0552151ba7675afe512ebe77fcc6eed68a0cb65775d31e38d44823e6796a0` |
| Quoter | `0x7dfd4f31be6814d2906bde155c3e1b146eac1468` | `0xf222999269407743c526ee7c9d0c9b4fabec26773d48fd6fd257c5ebca976ea7` |
| SwapRouter02 | `0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77` | `0xc53680bc70e67f7e8818a0e1302e9b70a4460493bc6dd6db056575b17cb3af25` |

The PositionManager reports the pinned Factory, and the 1% fee tier is enabled
with tick spacing `200`.

## Exclusions

- Security of Safe owner devices, seed phrases, signing policy, and recovery.
- Arc consensus, sequencer/validator behavior, RPC providers, bridges, and USDC.
- Correctness of upstream Uniswap V3 beyond pinned bytecode and interface bindings.
- Metadata content moderation and availability.
- Economic guarantees, market value, or protection from ordinary trading loss.
- A formal proof or an independent third-party audit.
