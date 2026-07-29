// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUniswapV3FactoryMinimal} from "../interfaces/IUniswapV3Minimal.sol";
import {MockUniswapV3Pool} from "./MockUniswapV3Pool.sol";

contract MockUniswapV3Factory is IUniswapV3FactoryMinimal {
    uint24 public constant SUPPORTED_FEE = 10_000;
    int24 public constant SUPPORTED_TICK_SPACING = 200;

    mapping(address token0 => mapping(address token1 => mapping(uint24 fee => address pool)))
        private _pools;

    event PoolCreated(
        address indexed token0,
        address indexed token1,
        uint24 indexed fee,
        address pool
    );

    error InvalidPair();
    error UnsupportedFee();
    error PoolExists();

    function getPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external view returns (address pool) {
        (address token0, address token1) = _sort(tokenA, tokenB);
        return _pools[token0][token1][fee];
    }

    function feeAmountTickSpacing(
        uint24 fee
    ) external pure returns (int24 tickSpacing) {
        return fee == SUPPORTED_FEE ? SUPPORTED_TICK_SPACING : int24(0);
    }

    function createPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external returns (address pool) {
        if (fee != SUPPORTED_FEE) revert UnsupportedFee();
        (address token0, address token1) = _sort(tokenA, tokenB);
        if (_pools[token0][token1][fee] != address(0)) revert PoolExists();
        pool = address(
            new MockUniswapV3Pool(address(this), token0, token1, fee, msg.sender)
        );
        _pools[token0][token1][fee] = pool;
        emit PoolCreated(token0, token1, fee, pool);
    }

    function _sort(
        address tokenA,
        address tokenB
    ) private pure returns (address token0, address token1) {
        if (tokenA == address(0) || tokenB == address(0) || tokenA == tokenB) {
            revert InvalidPair();
        }
        return tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }
}
