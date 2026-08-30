// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArcOriginUniswapV3Math} from "../uniswap/ArcOriginUniswapV3Math.sol";

contract MockArcOriginUniswapV3MathHarness {
    function singleSidedTicks(
        int24 currentTick,
        int24 tickSpacing,
        bool tokenIsToken0
    ) external pure returns (int24 tickLower, int24 tickUpper) {
        return ArcOriginUniswapV3Math.singleSidedTicks(
            currentTick,
            tickSpacing,
            tokenIsToken0
        );
    }

    function marketCapFromSqrtPriceX96(
        uint160 sqrtPriceX96,
        uint256 tokenSupply,
        bool tokenIsToken0
    ) external pure returns (uint256 marketCap) {
        return ArcOriginUniswapV3Math.marketCapFromSqrtPriceX96(
            sqrtPriceX96,
            tokenSupply,
            tokenIsToken0
        );
    }
}
