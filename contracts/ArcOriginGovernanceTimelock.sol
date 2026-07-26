// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Self-administered governance delay controlled by an external multisig.
/// @dev The governance Safe is the only proposer/canceller. Execution is public
///      after the delay so a lost executor key cannot permanently block operations.
contract ArcOriginGovernanceTimelock is TimelockController {
    uint256 public constant MINIMUM_DELAY = 2 days;

    error ZeroAddress();
    error DelayTooShort();

    constructor(uint256 minimumDelay, address governanceSafe)
        TimelockController(
            minimumDelay,
            _singleton(governanceSafe),
            _singleton(address(0)),
            address(0)
        )
    {
        if (governanceSafe == address(0)) revert ZeroAddress();
        if (minimumDelay < MINIMUM_DELAY) revert DelayTooShort();
    }

    function _singleton(address account) private pure returns (address[] memory accounts) {
        accounts = new address[](1);
        accounts[0] = account;
    }
}
