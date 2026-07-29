// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IArcOriginUniswapV3Locker {
    struct PositionRecordParams {
        uint256 positionId;
        address pool;
        address token0;
        address token1;
        address creatorFeeRecipient;
        uint16 creatorFeeShareBps;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 principal0;
        uint256 principal1;
        uint256 amount0Used;
        uint256 amount1Used;
    }

    function adapter() external view returns (address);
    function positionManager() external view returns (address);
    function protocolFeeRecipient() external view returns (address);
    function getPositionRecord(
        uint256 positionId
    ) external view returns (PositionRecordParams memory);

    function registerPosition(PositionRecordParams calldata params) external;
}
