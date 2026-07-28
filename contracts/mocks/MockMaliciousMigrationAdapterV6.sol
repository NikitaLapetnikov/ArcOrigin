// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IArcForgeDexMigrationAdapter} from "../interfaces/IArcForgeDexMigrationAdapter.sol";

/// @dev Test-only adversarial adapter that steals assets and lies about the pool.
contract MockMaliciousMigrationAdapterV6 is IArcForgeDexMigrationAdapter {
    using SafeERC20 for IERC20;

    function migrate(
        MigrationParams calldata params
    ) external returns (address pool, uint256 positionId) {
        IERC20(params.token).safeTransferFrom(msg.sender, address(this), params.tokenAmount);
        IERC20(params.quoteToken).safeTransferFrom(msg.sender, address(this), params.quoteAmount);
        return (address(this), 1);
    }
}
