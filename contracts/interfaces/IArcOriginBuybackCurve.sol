// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IArcOriginBuybackCurve {
    function token() external view returns (address);
    function usdc() external view returns (address);
    function virtualUsdcReserve() external view returns (uint256);
    function migrationConfigurationHash() external view returns (bytes32);
    function isMigrated() external view returns (bool);
    function quoteBuy(uint256 usdcAmount) external view returns (uint256 tokensOut, uint256 fee);
    function buy(
        uint256 usdcAmount,
        uint256 minTokensOut,
        uint256 deadline
    ) external returns (uint256 tokensOut);
}
