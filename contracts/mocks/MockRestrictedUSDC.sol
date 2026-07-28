// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockRestrictedUSDC is ERC20 {
    mapping(address account => bool blocked) public isBlocked;

    constructor() ERC20("Restricted USDC", "rUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool blocked) external {
        isBlocked[account] = blocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!isBlocked[to], "blocked recipient");
        super._update(from, to, value);
    }
}
