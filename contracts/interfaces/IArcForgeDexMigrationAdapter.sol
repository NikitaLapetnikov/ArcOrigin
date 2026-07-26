// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Adapter boundary between an ArcOrigin curve and a supported external DEX.
/// @dev A production adapter must atomically consume both assets, create full-range or
///      explicitly configured liquidity, and send the LP position to `liquidityLocker`.
interface IArcForgeDexMigrationAdapter {
    struct MigrationParams {
        address token;
        address quoteToken;
        uint256 tokenAmount;
        uint256 quoteAmount;
        address liquidityLocker;
        address creatorFeeRecipient;
        uint16 creatorFeeShareBps;
    }

    /// @return pool Canonical pool created or used by the adapter.
    /// @return positionId LP NFT id, or zero for fungible LP implementations.
    function migrate(MigrationParams calldata params) external returns (address pool, uint256 positionId);
}
