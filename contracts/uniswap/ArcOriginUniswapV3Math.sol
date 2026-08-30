// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

library ArcOriginUniswapV3Math {
    uint256 internal constant Q64 = 1 << 64;
    uint256 internal constant Q128 = 1 << 128;
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

    /// @notice Returns a range that requires only the launch token at the current price.
    function singleSidedTicks(
        int24 currentTick,
        int24 tickSpacing,
        bool launchTokenIsToken0
    ) internal pure returns (int24 tickLower, int24 tickUpper) {
        (int24 minUsableTick, int24 maxUsableTick) = usableTicks(tickSpacing);
        int24 tickFloor = (currentTick / tickSpacing) * tickSpacing;
        if (currentTick < 0 && currentTick % tickSpacing != 0) {
            tickFloor -= tickSpacing;
        }

        if (launchTokenIsToken0) {
            tickLower = tickFloor + tickSpacing;
            tickUpper = maxUsableTick;
        } else {
            tickLower = minUsableTick;
            tickUpper = tickFloor;
        }
        if (tickLower >= tickUpper) revert PriceOutOfRange();
    }

    /// @notice Market cap in raw quote-token units for a fixed raw token supply.
    function marketCapFromSqrtPriceX96(
        uint160 sqrtPriceX96,
        uint256 tokenSupply,
        bool launchTokenIsToken0
    ) internal pure returns (uint256 marketCap) {
        if (sqrtPriceX96 == 0 || tokenSupply == 0) revert InvalidAmounts();
        uint256 sqrtPrice = uint256(sqrtPriceX96);
        if (sqrtPrice <= type(uint128).max) {
            uint256 ratioX192 = sqrtPrice * sqrtPrice;
            return launchTokenIsToken0
                ? Math.mulDiv(ratioX192, tokenSupply, Q192)
                : Math.mulDiv(Q192, tokenSupply, ratioX192);
        }

        uint256 ratioX128 = Math.mulDiv(sqrtPrice, sqrtPrice, Q64);
        return launchTokenIsToken0
            ? Math.mulDiv(ratioX128, tokenSupply, Q128)
            : Math.mulDiv(Q128, tokenSupply, ratioX128);
    }
}
