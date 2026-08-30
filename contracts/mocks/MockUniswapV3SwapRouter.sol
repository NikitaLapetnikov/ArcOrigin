// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUniswapV3SwapRouterMinimal} from "../interfaces/IUniswapV3Minimal.sol";
import {MockUniswapV3Factory} from "./MockUniswapV3Factory.sol";
import {MockUniswapV3Pool} from "./MockUniswapV3Pool.sol";

contract MockUniswapV3SwapRouter is IUniswapV3SwapRouterMinimal {
    using SafeERC20 for IERC20;

    uint256 private constant MOCK_TOKEN_OUTPUT_PER_QUOTE_UNIT = 200_000 * 1e12;

    address public immutable factory;

    error InvalidSwap();

    constructor(address factory_) {
        factory = factory_;
    }

    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut) {
        address pool = MockUniswapV3Factory(factory).getPool(
            params.tokenIn,
            params.tokenOut,
            params.fee
        );
        if (
            pool == address(0) ||
            params.recipient == address(0) ||
            params.amountIn == 0 ||
            params.sqrtPriceLimitX96 == 0
        ) revert InvalidSwap();

        amountOut = params.amountIn * MOCK_TOKEN_OUTPUT_PER_QUOTE_UNIT;
        if (amountOut < params.amountOutMinimum) revert InvalidSwap();
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, pool, params.amountIn);
        MockUniswapV3Pool(pool).pay(params.tokenOut, params.recipient, amountOut);
    }
}
