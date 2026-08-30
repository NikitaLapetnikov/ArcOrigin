// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Fixed-supply launch token with no owner, mint, tax, pause, or blacklist.
/// @dev Holders may only burn their own balance. The factory uses the same primitive for LP rounding dust.
contract ArcForgeToken is ERC20 {
    address public immutable creator;
    address public immutable factory;
    string public metadataURI;

    event TokenInitialized(
        address indexed token,
        address indexed creator,
        uint256 totalSupply,
        string metadataURI
    );

    error InvalidCreator();
    error InvalidSupply();
    error Unauthorized();

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        address creator_,
        string memory metadataURI_
    ) ERC20(name_, symbol_) {
        if (creator_ == address(0)) revert InvalidCreator();
        if (totalSupply_ == 0) revert InvalidSupply();

        creator = creator_;
        factory = msg.sender;
        metadataURI = metadataURI_;
        _mint(msg.sender, totalSupply_);
        emit TokenInitialized(address(this), creator_, totalSupply_, metadataURI_);
    }

    function burnFactoryDust(uint256 amount) external {
        if (msg.sender != factory) revert Unauthorized();
        if (amount != 0) _burn(factory, amount);
    }

    function burn(uint256 amount) external {
        if (amount != 0) _burn(msg.sender, amount);
    }
}
