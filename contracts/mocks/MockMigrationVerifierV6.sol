// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IArcForgeMigrationVerifierV6} from "../interfaces/IArcForgeMigrationVerifierV6.sol";
import {MockLiquidityLockerV6} from "./MockLiquidityLockerV6.sol";

/// @dev Test-only verifier. Production verifiers must inspect the exact supported DEX.
contract MockMigrationVerifierV6 is IArcForgeMigrationVerifierV6 {
    function verifyMigration(
        VerificationParams calldata params
    ) external view returns (bool) {
        (
            address adapter,
            address pool,
            address token,
            address quoteToken,
            uint256 tokenAmount,
            uint256 quoteAmount
        ) = MockLiquidityLockerV6(params.liquidityLocker).locks(params.positionId);
        return (
            adapter == params.adapter &&
            pool == params.pool &&
            token == params.token &&
            quoteToken == params.quoteToken &&
            tokenAmount == params.tokenAmount &&
            quoteAmount == params.quoteAmount &&
            IERC20(params.token).balanceOf(params.liquidityLocker) >= tokenAmount &&
            IERC20(params.quoteToken).balanceOf(params.liquidityLocker) >= quoteAmount
        );
    }
}
