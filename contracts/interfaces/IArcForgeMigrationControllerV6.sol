// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Read-only emergency boundary used by V6 curves before optional DEX migration.
interface IArcForgeMigrationControllerV6 {
    function isMigrationConfigurationApproved(bytes32 configurationHash) external view returns (bool);
}
