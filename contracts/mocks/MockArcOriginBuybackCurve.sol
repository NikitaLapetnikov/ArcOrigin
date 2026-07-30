// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Test-only curve used to verify the buyback controller's migration boundary.
contract MockArcOriginBuybackCurve {
    using SafeERC20 for IERC20;

    address public immutable token;
    address public immutable usdc;
    uint256 public immutable virtualUsdcReserve;
    bytes32 public immutable migrationConfigurationHash;
    bool public isMigrated;

    constructor(address token_, address usdc_, uint256 virtualUsdcReserve_) {
        token = token_;
        usdc = usdc_;
        virtualUsdcReserve = virtualUsdcReserve_;
        migrationConfigurationHash = keccak256("migration-enabled");
    }

    function setMigrated(bool migrated_) external {
        isMigrated = migrated_;
    }

    function quoteBuy(uint256 usdcAmount) external view returns (uint256 tokensOut, uint256 fee) {
        if (isMigrated || usdcAmount == 0) return (0, 0);
        return (usdcAmount, 0);
    }

    function buy(
        uint256 usdcAmount,
        uint256 minTokensOut,
        uint256
    ) external returns (uint256 tokensOut) {
        require(!isMigrated, "migrated");
        tokensOut = usdcAmount;
        require(tokensOut >= minTokensOut, "slippage");
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcAmount);
        IERC20(token).safeTransfer(msg.sender, tokensOut);
    }
}
