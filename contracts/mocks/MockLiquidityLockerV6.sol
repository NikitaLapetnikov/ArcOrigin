// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockLiquidityLockerV6 {
    struct LockRecord {
        address adapter;
        address pool;
        address token;
        address quoteToken;
        uint256 tokenAmount;
        uint256 quoteAmount;
    }

    mapping(uint256 positionId => LockRecord record) public locks;

    function recordLock(
        uint256 positionId,
        address pool,
        address token,
        address quoteToken,
        uint256 tokenAmount,
        uint256 quoteAmount
    ) external {
        require(positionId != 0 && locks[positionId].adapter == address(0), "invalid lock");
        locks[positionId] = LockRecord(
            msg.sender,
            pool,
            token,
            quoteToken,
            tokenAmount,
            quoteAmount
        );
    }
}
