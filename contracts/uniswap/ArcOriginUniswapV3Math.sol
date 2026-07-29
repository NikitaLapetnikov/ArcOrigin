// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

library ArcOriginUniswapV3Math {
    uint256 internal constant Q192 = 1 << 192;
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO =
        1461446703485210103287273052203988822378723970342;

    error InvalidAmounts();
    error InvalidTickSpacing();
    error PriceOutOfRange();

    function sortTokens(
        address tokenA,
        address tokenB,
        uint256 amountA,
        uint256 amountB
    )
        internal
        pure
        returns (address token0, address token1, uint256 amount0, uint256 amount1)
    {
        if (tokenA == address(0) || tokenB == address(0) || tokenA == tokenB) {
            revert InvalidAmounts();
        }
        if (tokenA < tokenB) return (tokenA, tokenB, amountA, amountB);
        return (tokenB, tokenA, amountB, amountA);
    }

    function encodeSqrtRatioX96(
        uint256 amount0,
        uint256 amount1
    ) internal pure returns (uint160 sqrtPriceX96) {
        if (amount0 == 0 || amount1 == 0) revert InvalidAmounts();
        uint256 ratioX192 = Math.mulDiv(amount1, Q192, amount0);
        uint256 sqrtRatio = Math.sqrt(ratioX192);
        if (sqrtRatio < MIN_SQRT_RATIO || sqrtRatio >= MAX_SQRT_RATIO) {
            revert PriceOutOfRange();
        }
        sqrtPriceX96 = uint160(sqrtRatio);
    }

    function usableTicks(
        int24 tickSpacing
    ) internal pure returns (int24 tickLower, int24 tickUpper) {
        if (tickSpacing <= 0) revert InvalidTickSpacing();
        tickLower = (MIN_TICK / tickSpacing) * tickSpacing;
        tickUpper = (MAX_TICK / tickSpacing) * tickSpacing;
        if (tickLower >= tickUpper) revert InvalidTickSpacing();
    }
}
