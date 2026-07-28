// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IArcForgeFeeVaultV6 {
    function collectFee(address asset, address payer, bytes32 feeType, uint256 amount) external;
    function setCollector(address collector, bool allowed) external;
}
