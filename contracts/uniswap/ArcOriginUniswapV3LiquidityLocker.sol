// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IArcOriginUniswapV3Locker} from "../interfaces/IArcOriginUniswapV3Locker.sol";
import {INonfungiblePositionManagerMinimal} from "../interfaces/IUniswapV3Minimal.sol";

/// @notice Permanently holds ArcOrigin Uniswap V3 LP NFTs and distributes fees.
/// @dev There is intentionally no NFT transfer, liquidity decrease, burn, rescue, or
///      administrative mutation path.
contract ArcOriginUniswapV3LiquidityLocker is
    IArcOriginUniswapV3Locker,
    IERC721Receiver,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;

    uint16 public constant BPS = 10_000;

    struct LockRecord {
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

    struct FeeDistribution {
        uint256 creatorAmount0;
        uint256 protocolAmount0;
        uint256 creatorAmount1;
        uint256 protocolAmount1;
    }

    address public immutable override adapter;
    INonfungiblePositionManagerMinimal private immutable _positionManager;
    address public immutable override protocolFeeRecipient;
    mapping(uint256 positionId => LockRecord record) public locks;

    event PositionLocked(
        uint256 indexed positionId,
        address indexed pool,
        address indexed creator,
        uint128 liquidity,
        uint256 principal0,
        uint256 principal1
    );
    event FeesClaimed(
        uint256 indexed positionId,
        address indexed creator,
        address indexed protocolRecipient,
        uint256 creatorAmount0,
        uint256 protocolAmount0,
        uint256 creatorAmount1,
        uint256 protocolAmount1
    );

    error ZeroAddress();
    error Unauthorized();
    error InvalidPosition();
    error PositionAlreadyRegistered();
    error UnsupportedAssetBehavior();

    constructor(
        address adapter_,
        address positionManager_,
        address protocolFeeRecipient_
    ) {
        if (
            adapter_ == address(0) ||
            positionManager_ == address(0) ||
            protocolFeeRecipient_ == address(0)
        ) revert ZeroAddress();
        if (adapter_.code.length == 0 || positionManager_.code.length == 0) {
            revert InvalidPosition();
        }
        adapter = adapter_;
        _positionManager = INonfungiblePositionManagerMinimal(positionManager_);
        protocolFeeRecipient = protocolFeeRecipient_;
    }

    function positionManager() external view override returns (address) {
        return address(_positionManager);
    }

    function getPositionRecord(
        uint256 positionId
    ) external view override returns (PositionRecordParams memory params) {
        LockRecord storage record = locks[positionId];
        params = PositionRecordParams({
            positionId: positionId,
            pool: record.pool,
            token0: record.token0,
            token1: record.token1,
            creatorFeeRecipient: record.creatorFeeRecipient,
            creatorFeeShareBps: record.creatorFeeShareBps,
            fee: record.fee,
            tickLower: record.tickLower,
            tickUpper: record.tickUpper,
            liquidity: record.liquidity,
            principal0: record.principal0,
            principal1: record.principal1,
            amount0Used: record.amount0Used,
            amount1Used: record.amount1Used
        });
    }

    function registerPosition(
        PositionRecordParams calldata params
    ) external override {
        if (msg.sender != adapter) revert Unauthorized();
        if (locks[params.positionId].pool != address(0)) {
            revert PositionAlreadyRegistered();
        }
        if (
            params.positionId == 0 ||
            params.pool == address(0) ||
            params.pool.code.length == 0 ||
            params.token0 == address(0) ||
            params.token1 == address(0) ||
            params.token0 >= params.token1 ||
            params.creatorFeeRecipient == address(0) ||
            params.creatorFeeShareBps > BPS ||
            params.liquidity == 0 ||
            params.principal0 == 0 ||
            params.principal1 == 0 ||
            params.amount0Used == 0 ||
            params.amount1Used == 0 ||
            params.amount0Used > params.principal0 ||
            params.amount1Used > params.principal1 ||
            _positionManager.ownerOf(params.positionId) != address(this)
        ) revert InvalidPosition();

        (
            ,
            ,
            address positionToken0,
            address positionToken1,
            uint24 positionFee,
            int24 positionTickLower,
            int24 positionTickUpper,
            uint128 positionLiquidity,
            ,
            ,
            ,
        ) = _positionManager.positions(params.positionId);
        if (
            positionToken0 != params.token0 ||
            positionToken1 != params.token1 ||
            positionFee != params.fee ||
            positionTickLower != params.tickLower ||
            positionTickUpper != params.tickUpper ||
            positionLiquidity != params.liquidity
        ) revert InvalidPosition();

        locks[params.positionId] = LockRecord({
            pool: params.pool,
            token0: params.token0,
            token1: params.token1,
            creatorFeeRecipient: params.creatorFeeRecipient,
            creatorFeeShareBps: params.creatorFeeShareBps,
            fee: params.fee,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: params.liquidity,
            principal0: params.principal0,
            principal1: params.principal1,
            amount0Used: params.amount0Used,
            amount1Used: params.amount1Used
        });
        emit PositionLocked(
            params.positionId,
            params.pool,
            params.creatorFeeRecipient,
            params.liquidity,
            params.principal0,
            params.principal1
        );
    }

    function collectFees(
        uint256 positionId
    )
        external
        nonReentrant
        returns (
            uint256,
            uint256,
            uint256,
            uint256
        )
    {
        LockRecord storage record = locks[positionId];
        if (
            record.pool == address(0) ||
            _positionManager.ownerOf(positionId) != address(this)
        ) {
            revert InvalidPosition();
        }

        (uint256 collected0, uint256 collected1) =
            _collectPositionFees(positionId, record.token0, record.token1);
        FeeDistribution memory distribution;
        distribution.creatorAmount0 =
            collected0 * record.creatorFeeShareBps / BPS;
        distribution.creatorAmount1 =
            collected1 * record.creatorFeeShareBps / BPS;
        distribution.protocolAmount0 =
            collected0 - distribution.creatorAmount0;
        distribution.protocolAmount1 =
            collected1 - distribution.creatorAmount1;

        _transferIfNonZero(
            record.token0,
            record.creatorFeeRecipient,
            distribution.creatorAmount0
        );
        _transferIfNonZero(
            record.token0,
            protocolFeeRecipient,
            distribution.protocolAmount0
        );
        _transferIfNonZero(
            record.token1,
            record.creatorFeeRecipient,
            distribution.creatorAmount1
        );
        _transferIfNonZero(
            record.token1,
            protocolFeeRecipient,
            distribution.protocolAmount1
        );

        _emitFeesClaimed(positionId, record, distribution);
        return (
            distribution.creatorAmount0,
            distribution.protocolAmount0,
            distribution.creatorAmount1,
            distribution.protocolAmount1
        );
    }

    function _collectPositionFees(
        uint256 positionId,
        address token0Address,
        address token1Address
    ) private returns (uint256 collected0, uint256 collected1) {
        IERC20 token0 = IERC20(token0Address);
        IERC20 token1 = IERC20(token1Address);
        uint256 balance0Before = token0.balanceOf(address(this));
        uint256 balance1Before = token1.balanceOf(address(this));
        (uint256 reported0, uint256 reported1) = _positionManager.collect(
            INonfungiblePositionManagerMinimal.CollectParams({
                tokenId: positionId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        collected0 = token0.balanceOf(address(this)) - balance0Before;
        collected1 = token1.balanceOf(address(this)) - balance1Before;
        if (collected0 != reported0 || collected1 != reported1) {
            revert UnsupportedAssetBehavior();
        }
    }

    function _transferIfNonZero(address token, address recipient, uint256 amount) private {
        if (amount != 0) IERC20(token).safeTransfer(recipient, amount);
    }

    function _emitFeesClaimed(
        uint256 positionId,
        LockRecord storage record,
        FeeDistribution memory distribution
    ) private {
        emit FeesClaimed(
            positionId,
            record.creatorFeeRecipient,
            protocolFeeRecipient,
            distribution.creatorAmount0,
            distribution.protocolAmount0,
            distribution.creatorAmount1,
            distribution.protocolAmount1
        );
    }

    function onERC721Received(
        address operator,
        address,
        uint256,
        bytes calldata
    ) external view override returns (bytes4) {
        if (msg.sender != address(_positionManager) || operator != adapter) {
            revert Unauthorized();
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}
