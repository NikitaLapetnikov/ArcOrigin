// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUniswapV3PoolMinimal} from "../interfaces/IUniswapV3Minimal.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockUniswapV3Pool is IUniswapV3PoolMinimal {
    using SafeERC20 for IERC20;

    address public immutable override factory;
    address public immutable override token0;
    address public immutable override token1;
    uint24 public immutable override fee;
    address public immutable positionManager;
    uint128 public override liquidity;
    uint160 private _sqrtPriceX96;
    int24 private _currentTick;
    int24 private _twapTick;
    uint16 private _observationCardinalityNext = 1;

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

    function setTicksForTest(int24 currentTick_, int24 twapTick_) external {
        _currentTick = currentTick_;
        _twapTick = twapTick_;
    }

    function increaseObservationCardinalityNext(
        uint16 observationCardinalityNext_
    ) external {
        if (observationCardinalityNext_ > _observationCardinalityNext) {
            _observationCardinalityNext = observationCardinalityNext_;
        }
    }

    function observe(
        uint32[] calldata secondsAgos
    ) external view returns (
        int56[] memory tickCumulatives,
        uint160[] memory secondsPerLiquidityCumulativeX128s
    ) {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 index; index < secondsAgos.length; ++index) {
            tickCumulatives[index] = -int56(_twapTick) * int56(uint56(secondsAgos[index]));
        }
    }

    function pay(address token, address recipient, uint256 amount) external {
        IERC20(token).safeTransfer(recipient, amount);
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
        return (
            _sqrtPriceX96,
            _currentTick,
            0,
            1,
            _observationCardinalityNext,
            0,
            true
        );
    }
}
