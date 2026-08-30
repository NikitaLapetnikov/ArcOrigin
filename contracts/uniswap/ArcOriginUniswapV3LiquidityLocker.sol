// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ArcForgeToken} from "../ArcForgeToken.sol";
import {
    INonfungiblePositionManagerMinimal,
    IUniswapV3PoolMinimal,
    IUniswapV3SwapRouterMinimal
} from "../interfaces/IUniswapV3Minimal.sol";

/// @notice Permanently holds launch LP NFTs, distributes ordinary creator fees,
///         and executes opt-in permissionless buyback-and-burn positions.
/// @dev There is intentionally no NFT transfer, approval, liquidity decrease,
///      rescue, or administrative mutation path.
contract ArcOriginUniswapV3LiquidityLocker is IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant BPS = 10_000;
    uint32 public constant BUYBACK_TWAP_WINDOW = 15 minutes;
    uint32 public constant BUYBACK_COOLDOWN = 15 minutes;
    uint256 public constant MIN_BUYBACK_QUOTE = 1e6;
    uint16 public constant KEEPER_REWARD_BPS = 50;
    uint256 public constant MAX_KEEPER_REWARD = 1e6;
    int24 public constant MAX_TWAP_DEVIATION = 600;
    uint16 public constant MAX_SQRT_PRICE_IMPACT_BPS = 200;
    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO =
        1461446703485210103287273052203988822378723970342;

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
        bool automaticBuyback;
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
        bool automaticBuyback;
    }

    address public immutable factory;
    INonfungiblePositionManagerMinimal private immutable _positionManager;
    IUniswapV3SwapRouterMinimal public immutable swapRouter;
    address public immutable quoteToken;
    address public immutable protocolFeeRecipient;
    mapping(uint256 positionId => LockRecord record) public locks;
    mapping(uint256 positionId => uint256 amount) public buybackReserve;
    mapping(uint256 positionId => uint64 timestamp) public lastBuybackAt;

    event PositionLocked(
        uint256 indexed positionId,
        address indexed pool,
        address indexed creator,
        address launchToken,
        uint128 liquidity,
        uint256 launchTokenPrincipal,
        bool automaticBuyback
    );
    event FeesClaimed(
        uint256 indexed positionId,
        address indexed creator,
        address indexed protocolRecipient,
        uint256 creatorAmount0,
        uint256 protocolAmount0,
        uint256 creatorAmount1,
        uint256 protocolAmount1,
        bool automaticBuyback
    );
    event BuybackFeesReserved(
        uint256 indexed positionId,
        uint256 quoteAmount,
        uint256 launchTokensBurned,
        uint256 totalQuoteReserve
    );
    event BuybackExecuted(
        uint256 indexed positionId,
        address indexed keeper,
        uint256 quoteSpent,
        uint256 keeperReward,
        uint256 launchTokensBurned,
        uint256 remainingQuoteReserve
    );

    error ZeroAddress();
    error Unauthorized();
    error InvalidPosition();
    error PositionAlreadyRegistered();
    error UnsupportedAssetBehavior();
    error BuybackDisabled();
    error BuybackNotReady();
    error UnsafePrice();
    error InvalidSwap();

    constructor(
        address factory_,
        address positionManager_,
        address swapRouter_,
        address quoteToken_,
        address protocolFeeRecipient_
    ) {
        if (
            factory_ == address(0) ||
            positionManager_ == address(0) ||
            swapRouter_ == address(0) ||
            quoteToken_ == address(0) ||
            protocolFeeRecipient_ == address(0)
        ) revert ZeroAddress();
        if (
            positionManager_.code.length == 0 ||
            swapRouter_.code.length == 0 ||
            quoteToken_.code.length == 0
        ) revert InvalidPosition();
        factory = factory_;
        _positionManager = INonfungiblePositionManagerMinimal(positionManager_);
        swapRouter = IUniswapV3SwapRouterMinimal(swapRouter_);
        quoteToken = quoteToken_;
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
            (quoteToken != params.token0 && quoteToken != params.token1) ||
            params.launchToken == quoteToken ||
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
            launchTokenPrincipal: params.launchTokenPrincipal,
            automaticBuyback: params.automaticBuyback
        });
        emit PositionLocked(
            params.positionId,
            params.pool,
            params.creatorFeeRecipient,
            params.launchToken,
            params.liquidity,
            params.launchTokenPrincipal,
            params.automaticBuyback
        );
    }

    function collectFees(
        uint256 positionId
    ) external nonReentrant returns (uint256, uint256, uint256, uint256) {
        return _collectAndRouteFees(positionId);
    }

    function collectAndExecuteBuyback(
        uint256 positionId
    ) external nonReentrant returns (uint256 quoteSpent, uint256 keeperReward, uint256 tokensBurned) {
        _collectAndRouteFees(positionId);
        return _executeBuyback(positionId, msg.sender);
    }

    function executeBuyback(
        uint256 positionId
    ) external nonReentrant returns (uint256 quoteSpent, uint256 keeperReward, uint256 tokensBurned) {
        return _executeBuyback(positionId, msg.sender);
    }

    function buybackReady(
        uint256 positionId
    ) external view returns (bool ready, uint256 reserve, uint256 nextExecutionAt) {
        LockRecord storage record = locks[positionId];
        if (!record.automaticBuyback) return (false, 0, 0);
        reserve = buybackReserve[positionId];
        nextExecutionAt = uint256(lastBuybackAt[positionId]) + BUYBACK_COOLDOWN;
        ready = reserve >= MIN_BUYBACK_QUOTE && block.timestamp >= nextExecutionAt;
    }

    function _collectAndRouteFees(
        uint256 positionId
    ) private returns (uint256, uint256, uint256, uint256) {
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

        _routeCreatorFees(record, positionId, creatorAmount0, creatorAmount1);
        _transferIfNonZero(record.token0, protocolFeeRecipient, protocolAmount0);
        _transferIfNonZero(record.token1, protocolFeeRecipient, protocolAmount1);

        emit FeesClaimed(
            positionId,
            record.creatorFeeRecipient,
            protocolFeeRecipient,
            creatorAmount0,
            protocolAmount0,
            creatorAmount1,
            protocolAmount1,
            record.automaticBuyback
        );
        return (creatorAmount0, protocolAmount0, creatorAmount1, protocolAmount1);
    }

    function _routeCreatorFees(
        LockRecord storage record,
        uint256 positionId,
        uint256 creatorAmount0,
        uint256 creatorAmount1
    ) private {
        if (!record.automaticBuyback) {
            _transferIfNonZero(record.token0, record.creatorFeeRecipient, creatorAmount0);
            _transferIfNonZero(record.token1, record.creatorFeeRecipient, creatorAmount1);
            return;
        }

        uint256 creatorQuoteAmount = record.token0 == quoteToken
            ? creatorAmount0
            : creatorAmount1;
        uint256 creatorLaunchTokenAmount = record.token0 == record.launchToken
            ? creatorAmount0
            : creatorAmount1;
        if (creatorQuoteAmount != 0) {
            buybackReserve[positionId] += creatorQuoteAmount;
        }
        if (creatorLaunchTokenAmount != 0) {
            ArcForgeToken(record.launchToken).burn(creatorLaunchTokenAmount);
        }
        emit BuybackFeesReserved(
            positionId,
            creatorQuoteAmount,
            creatorLaunchTokenAmount,
            buybackReserve[positionId]
        );
    }

    function _executeBuyback(
        uint256 positionId,
        address keeper
    ) private returns (uint256 quoteSpent, uint256 keeperReward, uint256 tokensBurned) {
        LockRecord storage record = locks[positionId];
        if (!record.automaticBuyback) revert BuybackDisabled();
        uint256 reserve = buybackReserve[positionId];
        if (
            reserve < MIN_BUYBACK_QUOTE ||
            block.timestamp < uint256(lastBuybackAt[positionId]) + BUYBACK_COOLDOWN
        ) revert BuybackNotReady();

        (uint160 currentSqrtPriceX96, int24 currentTick, , , , , ) =
            IUniswapV3PoolMinimal(record.pool).slot0();
        _requireSafeTwap(record.pool, currentTick);

        uint256 maximumReward = reserve * KEEPER_REWARD_BPS / BPS;
        if (maximumReward > MAX_KEEPER_REWARD) maximumReward = MAX_KEEPER_REWARD;
        uint256 swapBudget = reserve - maximumReward;
        (quoteSpent, tokensBurned) = _swapBuyback(
            record,
            swapBudget,
            _buybackPriceLimit(currentSqrtPriceX96, quoteToken == record.token0)
        );

        keeperReward = _finalizeBuyback(
            record,
            positionId,
            keeper,
            reserve,
            quoteSpent,
            tokensBurned
        );
    }

    function _finalizeBuyback(
        LockRecord storage record,
        uint256 positionId,
        address keeper,
        uint256 reserve,
        uint256 quoteSpent,
        uint256 tokensBurned
    ) private returns (uint256 keeperReward) {
        keeperReward = quoteSpent * KEEPER_REWARD_BPS / BPS;
        if (keeperReward > MAX_KEEPER_REWARD) keeperReward = MAX_KEEPER_REWARD;
        uint256 remainingReserve = reserve - quoteSpent - keeperReward;
        buybackReserve[positionId] = remainingReserve;
        lastBuybackAt[positionId] = uint64(block.timestamp);
        ArcForgeToken(record.launchToken).burn(tokensBurned);
        _transferIfNonZero(quoteToken, keeper, keeperReward);
        emit BuybackExecuted(
            positionId,
            keeper,
            quoteSpent,
            keeperReward,
            tokensBurned,
            remainingReserve
        );
    }

    function _swapBuyback(
        LockRecord storage record,
        uint256 swapBudget,
        uint160 sqrtPriceLimitX96
    ) private returns (uint256 quoteSpent, uint256 tokensReceived) {
        IERC20 quote = IERC20(quoteToken);
        IERC20 launchToken = IERC20(record.launchToken);
        uint256 quoteBefore = quote.balanceOf(address(this));
        uint256 tokenBefore = launchToken.balanceOf(address(this));
        quote.forceApprove(address(swapRouter), swapBudget);
        uint256 reportedOutput = swapRouter.exactInputSingle(
            IUniswapV3SwapRouterMinimal.ExactInputSingleParams({
                tokenIn: quoteToken,
                tokenOut: record.launchToken,
                fee: record.fee,
                recipient: address(this),
                amountIn: swapBudget,
                amountOutMinimum: 1,
                sqrtPriceLimitX96: sqrtPriceLimitX96
            })
        );
        quote.forceApprove(address(swapRouter), 0);

        uint256 quoteAfter = quote.balanceOf(address(this));
        uint256 tokenAfter = launchToken.balanceOf(address(this));
        if (quoteAfter > quoteBefore || tokenAfter < tokenBefore) revert InvalidSwap();
        quoteSpent = quoteBefore - quoteAfter;
        tokensReceived = tokenAfter - tokenBefore;
        if (
            quoteSpent == 0 ||
            quoteSpent > swapBudget ||
            tokensReceived == 0 ||
            tokensReceived != reportedOutput
        ) revert InvalidSwap();
    }

    function _requireSafeTwap(address pool, int24 currentTick) private view {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = BUYBACK_TWAP_WINDOW;
        secondsAgos[1] = 0;
        (int56[] memory tickCumulatives, ) = IUniswapV3PoolMinimal(pool).observe(secondsAgos);
        int56 tickDelta = tickCumulatives[1] - tickCumulatives[0];
        int56 window = int56(uint56(BUYBACK_TWAP_WINDOW));
        int24 averageTick = int24(tickDelta / window);
        if (tickDelta < 0 && tickDelta % window != 0) averageTick--;
        int256 deviation = int256(currentTick) - int256(averageTick);
        if (deviation < 0) deviation = -deviation;
        if (deviation > int256(MAX_TWAP_DEVIATION)) revert UnsafePrice();
    }

    function _buybackPriceLimit(
        uint160 currentSqrtPriceX96,
        bool quoteIsToken0
    ) private pure returns (uint160 limit) {
        uint256 rawLimit = quoteIsToken0
            ? uint256(currentSqrtPriceX96) * (BPS - MAX_SQRT_PRICE_IMPACT_BPS) / BPS
            : uint256(currentSqrtPriceX96) * (BPS + MAX_SQRT_PRICE_IMPACT_BPS) / BPS;
        if (quoteIsToken0 && rawLimit <= MIN_SQRT_RATIO) return MIN_SQRT_RATIO + 1;
        if (!quoteIsToken0 && rawLimit >= MAX_SQRT_RATIO) return MAX_SQRT_RATIO - 1;
        limit = uint160(rawLimit);
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
