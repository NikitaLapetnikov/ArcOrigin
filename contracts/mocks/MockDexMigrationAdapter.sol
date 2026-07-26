// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IArcForgeDexMigrationAdapter} from "../interfaces/IArcForgeDexMigrationAdapter.sol";

/// @dev Test-only adapter. It represents an external pool by holding both migrated assets.
contract MockDexMigrationAdapter is IArcForgeDexMigrationAdapter {
    using SafeERC20 for IERC20;

    address public immutable pool;
    uint256 public nextPositionId = 1;

    constructor() {
        pool = address(this);
    }

    function migrate(MigrationParams calldata params) external returns (address, uint256 positionId) {
        IERC20(params.token).safeTransferFrom(msg.sender, address(this), params.tokenAmount);
        IERC20(params.quoteToken).safeTransferFrom(msg.sender, address(this), params.quoteAmount);
        positionId = nextPositionId++;
        return (pool, positionId);
    }
}
