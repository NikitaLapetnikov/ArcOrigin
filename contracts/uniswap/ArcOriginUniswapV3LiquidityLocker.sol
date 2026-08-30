// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {INonfungiblePositionManagerMinimal} from "../interfaces/IUniswapV3Minimal.sol";

/// @notice Permanently holds launch LP NFTs and permissionlessly distributes LP fees.
/// @dev There is intentionally no NFT transfer, approval, liquidity decrease, burn, rescue,
///      or administrative mutation path.
contract ArcOriginUniswapV3LiquidityLocker is IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant BPS = 10_000;

    struct LockRecord {
        address pool;
        address token0;
        address token1;
        address launchToken;
        address creatorFeeRecipient;
        uint16 creatorFeeShareBps;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 launchTokenPrincipal;
    }

    struct RegisterParams {
        uint256 positionId;
        address pool;
        address token0;
        address token1;
        address launchToken;
        address creatorFeeRecipient;
        uint16 creatorFeeShareBps;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 launchTokenPrincipal;
    }

    address public immutable factory;
    INonfungiblePositionManagerMinimal private immutable _positionManager;
    address public immutable protocolFeeRecipient;
    mapping(uint256 positionId => LockRecord record) public locks;

    event PositionLocked(
        uint256 indexed positionId,
        address indexed pool,
        address indexed creator,
        address launchToken,
        uint128 liquidity,
        uint256 launchTokenPrincipal
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
        address factory_,
        address positionManager_,
        address protocolFeeRecipient_
    ) {
        if (
            factory_ == address(0) ||
            positionManager_ == address(0) ||
            protocolFeeRecipient_ == address(0)
        ) revert ZeroAddress();
        if (positionManager_.code.length == 0) revert InvalidPosition();
        factory = factory_;
        _positionManager = INonfungiblePositionManagerMinimal(positionManager_);
        protocolFeeRecipient = protocolFeeRecipient_;
    }

    function positionManager() external view returns (address) {
        return address(_positionManager);
    }

    function registerPosition(RegisterParams calldata params) external {
        if (msg.sender != factory) revert Unauthorized();
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
            (params.launchToken != params.token0 && params.launchToken != params.token1) ||
            params.creatorFeeRecipient == address(0) ||
            params.creatorFeeShareBps > BPS ||
            params.tickLower >= params.tickUpper ||
            params.liquidity == 0 ||
            params.launchTokenPrincipal == 0 ||
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
            launchToken: params.launchToken,
            creatorFeeRecipient: params.creatorFeeRecipient,
            creatorFeeShareBps: params.creatorFeeShareBps,
            fee: params.fee,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: params.liquidity,
            launchTokenPrincipal: params.launchTokenPrincipal
        });
        emit PositionLocked(
            params.positionId,
            params.pool,
            params.creatorFeeRecipient,
            params.launchToken,
            params.liquidity,
            params.launchTokenPrincipal
        );
    }

    function collectFees(
        uint256 positionId
    ) external nonReentrant returns (uint256, uint256, uint256, uint256) {
        LockRecord storage record = locks[positionId];
        if (
            record.pool == address(0) ||
            _positionManager.ownerOf(positionId) != address(this)
        ) revert InvalidPosition();

        (uint256 collected0, uint256 collected1) =
            _collectPositionFees(positionId, record.token0, record.token1);
        uint256 creatorAmount0 = collected0 * record.creatorFeeShareBps / BPS;
        uint256 creatorAmount1 = collected1 * record.creatorFeeShareBps / BPS;
        uint256 protocolAmount0 = collected0 - creatorAmount0;
        uint256 protocolAmount1 = collected1 - creatorAmount1;

        _transferIfNonZero(record.token0, record.creatorFeeRecipient, creatorAmount0);
        _transferIfNonZero(record.token0, protocolFeeRecipient, protocolAmount0);
        _transferIfNonZero(record.token1, record.creatorFeeRecipient, creatorAmount1);
        _transferIfNonZero(record.token1, protocolFeeRecipient, protocolAmount1);

        emit FeesClaimed(
            positionId,
            record.creatorFeeRecipient,
            protocolFeeRecipient,
            creatorAmount0,
            protocolAmount0,
            creatorAmount1,
            protocolAmount1
        );
        return (creatorAmount0, protocolAmount0, creatorAmount1, protocolAmount1);
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

    function onERC721Received(
        address operator,
        address,
        uint256,
        bytes calldata
    ) external view override returns (bytes4) {
        if (msg.sender != address(_positionManager) || operator != factory) {
            revert Unauthorized();
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}
