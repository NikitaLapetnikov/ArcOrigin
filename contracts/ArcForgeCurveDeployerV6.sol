// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ArcForgeBondingCurveV6} from "./ArcForgeBondingCurveV6.sol";

/// @notice One-time-bound deployer that keeps Factory V6 runtime below EIP-170.
contract ArcForgeCurveDeployerV6 is Ownable {
    address public factory;

    event FactoryBound(address indexed factory);

    error ZeroAddress();
    error AlreadyBound();
    error Unauthorized();

    constructor(address owner_) Ownable(owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
    }

    function bindFactory(address factory_) external onlyOwner {
        if (factory != address(0)) revert AlreadyBound();
        if (factory_ == address(0) || factory_.code.length == 0) revert ZeroAddress();
        factory = factory_;
        emit FactoryBound(factory_);
        _transferOwnership(address(0));
    }

    function deployCurve(
        ArcForgeBondingCurveV6.CurveConfig calldata config
    ) external returns (address curve) {
        if (msg.sender != factory) revert Unauthorized();
        curve = address(new ArcForgeBondingCurveV6(config));
    }
}
