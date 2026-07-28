// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice DEX-specific, independently deployed verifier for a completed V6 migration.
/// @dev A production verifier must read canonical DEX and locker state. It must not trust
///      values returned by the migration adapter without validating them onchain.
interface IArcForgeMigrationVerifierV6 {
    struct VerificationParams {
        address adapter;
        address token;
        address quoteToken;
        address pool;
        address liquidityLocker;
        uint256 positionId;
        uint256 tokenAmount;
        uint256 quoteAmount;
    }

    function verifyMigration(VerificationParams calldata params) external view returns (bool);
}
