// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IArcForgeDexMigrationAdapter} from "../interfaces/IArcForgeDexMigrationAdapter.sol";
import {MockLiquidityLockerV6} from "./MockLiquidityLockerV6.sol";

/// @dev Test-only adapter that models assets being placed under locker custody.
contract MockDexMigrationAdapterV6 is IArcForgeDexMigrationAdapter {
    using SafeERC20 for IERC20;

    uint256 public nextPositionId = 1;

    function migrate(
        MigrationParams calldata params
    ) external returns (address pool, uint256 positionId) {
        pool = address(this);
        positionId = nextPositionId++;
        IERC20(params.token).safeTransferFrom(msg.sender, params.liquidityLocker, params.tokenAmount);
        IERC20(params.quoteToken).safeTransferFrom(
            msg.sender,
            params.liquidityLocker,
            params.quoteAmount
        );
        MockLiquidityLockerV6(params.liquidityLocker).recordLock(
            positionId,
            pool,
            params.token,
            params.quoteToken,
            params.tokenAmount,
            params.quoteAmount
        );
    }
}
