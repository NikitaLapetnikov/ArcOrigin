// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUniswapV3PoolMinimal} from "../interfaces/IUniswapV3Minimal.sol";

contract MockUniswapV3Pool is IUniswapV3PoolMinimal {
    address public immutable override factory;
    address public immutable override token0;
    address public immutable override token1;
    uint24 public immutable override fee;
    address public immutable positionManager;
    uint128 public override liquidity;
    uint160 private _sqrtPriceX96;

    error AlreadyInitialized();
    error InvalidPrice();

    constructor(
        address factory_,
        address token0_,
        address token1_,
        uint24 fee_,
        address positionManager_
    ) {
        factory = factory_;
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
        positionManager = positionManager_;
    }

    function initialize(uint160 sqrtPriceX96_) external {
        if (_sqrtPriceX96 != 0) revert AlreadyInitialized();
        if (sqrtPriceX96_ == 0) revert InvalidPrice();
        _sqrtPriceX96 = sqrtPriceX96_;
    }

    function addLiquidity(uint128 amount) external {
        liquidity += amount;
    }

    function setSqrtPriceX96ForTest(uint160 sqrtPriceX96_) external {
        if (sqrtPriceX96_ == 0) revert InvalidPrice();
        _sqrtPriceX96 = sqrtPriceX96_;
    }

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        return (_sqrtPriceX96, 0, 0, 1, 1, 0, true);
    }
}
