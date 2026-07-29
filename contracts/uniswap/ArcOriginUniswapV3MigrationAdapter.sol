// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IArcForgeDexMigrationAdapter} from "../interfaces/IArcForgeDexMigrationAdapter.sol";
import {IArcOriginUniswapV3Locker} from "../interfaces/IArcOriginUniswapV3Locker.sol";
import {
    IUniswapV3FactoryMinimal,
    INonfungiblePositionManagerMinimal
} from "../interfaces/IUniswapV3Minimal.sol";
import {ArcOriginUniswapV3Math} from "./ArcOriginUniswapV3Math.sol";

interface IArcOriginFactoryLaunchRegistry {
    struct TokenInfo {
        address token;
        address curve;
        address creator;
        uint64 launchedAt;
        string metadataURI;
    }

    function getTokenInfo(address token) external view returns (TokenInfo memory);
    function feeVault() external view returns (address);
}

interface IArcOriginV6MigrationSource {
    function token() external view returns (IERC20);
    function usdc() external view returns (IERC20);
    function creatorFeeRecipient() external view returns (address);
    function migrationController() external view returns (address);
    function dexMigrationAdapter() external view returns (address);
    function liquidityLocker() external view returns (address);
    function tokenReserve() external view returns (uint256);
    function usdcReserve() external view returns (uint256);
    function isGraduated() external view returns (bool);
    function isMigrated() external view returns (bool);
}

/// @notice Immutable ArcOrigin adapter that creates a fresh, full-range Uniswap V3 pool.
/// @dev Existing pools are rejected. A pre-created pool can only deny migration; it can
///      never redirect funds, and the source curve remains a usable permanent AMM.
contract ArcOriginUniswapV3MigrationAdapter is
    IArcForgeDexMigrationAdapter,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;

    uint16 public constant BPS = 10_000;
    uint16 public constant CREATOR_FEE_SHARE_BPS = 7_000;
    uint16 public constant MIN_LIQUIDITY_USAGE_BPS = 9_990;
    uint24 public constant POOL_FEE = 10_000;

    address public immutable migrationController;
    IUniswapV3FactoryMinimal public immutable v3Factory;
    INonfungiblePositionManagerMinimal public immutable positionManager;
    IERC20 public immutable quoteToken;
    int24 public immutable tickSpacing;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;

    struct MigrationContext {
        address token0;
        address token1;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 tokenBalanceBefore;
        uint256 quoteBalanceBefore;
    }

    struct MintResult {
        address pool;
        uint256 positionId;
        uint128 liquidity;
        uint256 amount0Used;
        uint256 amount1Used;
    }

    event LiquidityMigrated(
        address indexed curve,
        address indexed pool,
        uint256 indexed positionId,
        uint128 liquidity,
        uint256 amount0Used,
        uint256 amount1Used
    );

    error ZeroAddress();
    error InvalidConfiguration();
    error UnauthorizedCurve();
    error ExistingPool();
    error UnsupportedAssetBehavior();
    error InsufficientLiquidityMinted();
    error ResidualBalance();

    constructor(
        address migrationController_,
        address v3Factory_,
        address positionManager_,
        address quoteToken_
    ) {
        if (
            migrationController_ == address(0) ||
            v3Factory_ == address(0) ||
            positionManager_ == address(0) ||
            quoteToken_ == address(0)
        ) revert ZeroAddress();
        if (
            migrationController_.code.length == 0 ||
            v3Factory_.code.length == 0 ||
            positionManager_.code.length == 0 ||
            quoteToken_.code.length == 0
        ) revert InvalidConfiguration();

        IUniswapV3FactoryMinimal factory = IUniswapV3FactoryMinimal(v3Factory_);
        INonfungiblePositionManagerMinimal manager =
            INonfungiblePositionManagerMinimal(positionManager_);
        if (manager.factory() != v3Factory_) revert InvalidConfiguration();
        int24 spacing = factory.feeAmountTickSpacing(POOL_FEE);
        (int24 lower, int24 upper) = ArcOriginUniswapV3Math.usableTicks(spacing);

        migrationController = migrationController_;
        v3Factory = factory;
        positionManager = manager;
        quoteToken = IERC20(quoteToken_);
        tickSpacing = spacing;
        tickLower = lower;
        tickUpper = upper;
    }

    function migrate(
        MigrationParams calldata params
    ) external nonReentrant returns (address pool, uint256 positionId) {
        _validateSource(params);
        _validateLocker(params.liquidityLocker);
        MigrationContext memory context = _pullAssets(params);
        MintResult memory result = _mintPosition(
            params.liquidityLocker,
            context
        );
        _lockPosition(params, context, result);
        _assertNoResidualBalance(params, context);

        emit LiquidityMigrated(
            msg.sender,
            result.pool,
            result.positionId,
            result.liquidity,
            result.amount0Used,
            result.amount1Used
        );
        return (result.pool, result.positionId);
    }

    function _validateLocker(address liquidityLocker_) private view {
        IArcOriginUniswapV3Locker targetLocker =
            IArcOriginUniswapV3Locker(liquidityLocker_);
        if (
            targetLocker.adapter() != address(this) ||
            targetLocker.positionManager() != address(positionManager) ||
            targetLocker.protocolFeeRecipient() !=
            IArcOriginFactoryLaunchRegistry(migrationController).feeVault()
        ) revert InvalidConfiguration();
    }

    function _pullAssets(
        MigrationParams calldata params
    ) private returns (MigrationContext memory context) {
        (
            context.token0,
            context.token1,
            context.amount0Desired,
            context.amount1Desired
        ) = ArcOriginUniswapV3Math.sortTokens(
            params.token,
            params.quoteToken,
            params.tokenAmount,
            params.quoteAmount
        );
        if (
            v3Factory.getPool(context.token0, context.token1, POOL_FEE) !=
            address(0)
        ) revert ExistingPool();

        context.tokenBalanceBefore =
            IERC20(params.token).balanceOf(address(this));
        context.quoteBalanceBefore =
            IERC20(params.quoteToken).balanceOf(address(this));
        IERC20(params.token).safeTransferFrom(msg.sender, address(this), params.tokenAmount);
        IERC20(params.quoteToken).safeTransferFrom(
            msg.sender,
            address(this),
            params.quoteAmount
        );
        if (
            IERC20(params.token).balanceOf(address(this)) -
                context.tokenBalanceBefore !=
            params.tokenAmount ||
            IERC20(params.quoteToken).balanceOf(address(this)) -
                context.quoteBalanceBefore !=
            params.quoteAmount
        ) revert UnsupportedAssetBehavior();
    }

    function _mintPosition(
        address liquidityLocker_,
        MigrationContext memory context
    ) private returns (MintResult memory result) {
        uint160 sqrtPriceX96 = ArcOriginUniswapV3Math.encodeSqrtRatioX96(
            context.amount0Desired,
            context.amount1Desired
        );
        result.pool = positionManager.createAndInitializePoolIfNecessary(
            context.token0,
            context.token1,
            POOL_FEE,
            sqrtPriceX96
        );
        if (
            result.pool == address(0) ||
            result.pool.code.length == 0 ||
            v3Factory.getPool(context.token0, context.token1, POOL_FEE) !=
            result.pool
        ) revert InvalidConfiguration();

        IERC20(context.token0).forceApprove(
            address(positionManager),
            context.amount0Desired
        );
        IERC20(context.token1).forceApprove(
            address(positionManager),
            context.amount1Desired
        );
        (
            result.positionId,
            result.liquidity,
            result.amount0Used,
            result.amount1Used
        ) = positionManager.mint(
            INonfungiblePositionManagerMinimal.MintParams({
                token0: context.token0,
                token1: context.token1,
                fee: POOL_FEE,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: context.amount0Desired,
                amount1Desired: context.amount1Desired,
                amount0Min: context.amount0Desired * MIN_LIQUIDITY_USAGE_BPS / BPS,
                amount1Min: context.amount1Desired * MIN_LIQUIDITY_USAGE_BPS / BPS,
                recipient: liquidityLocker_,
                deadline: block.timestamp
            })
        );
        IERC20(context.token0).forceApprove(address(positionManager), 0);
        IERC20(context.token1).forceApprove(address(positionManager), 0);
        if (
            result.positionId == 0 ||
            result.liquidity == 0 ||
            result.amount0Used > context.amount0Desired ||
            result.amount1Used > context.amount1Desired ||
            result.amount0Used * BPS <
            context.amount0Desired * MIN_LIQUIDITY_USAGE_BPS ||
            result.amount1Used * BPS <
            context.amount1Desired * MIN_LIQUIDITY_USAGE_BPS
        ) revert InsufficientLiquidityMinted();
    }

    function _lockPosition(
        MigrationParams calldata params,
        MigrationContext memory context,
        MintResult memory result
    ) private {
        uint256 dust0 = context.amount0Desired - result.amount0Used;
        uint256 dust1 = context.amount1Desired - result.amount1Used;
        if (dust0 != 0) {
            IERC20(context.token0).safeTransfer(params.liquidityLocker, dust0);
        }
        if (dust1 != 0) {
            IERC20(context.token1).safeTransfer(params.liquidityLocker, dust1);
        }

        IArcOriginUniswapV3Locker(params.liquidityLocker).registerPosition(
            IArcOriginUniswapV3Locker.PositionRecordParams({
                positionId: result.positionId,
                pool: result.pool,
                token0: context.token0,
                token1: context.token1,
                creatorFeeRecipient: params.creatorFeeRecipient,
                creatorFeeShareBps: params.creatorFeeShareBps,
                fee: POOL_FEE,
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidity: result.liquidity,
                principal0: context.amount0Desired,
                principal1: context.amount1Desired,
                amount0Used: result.amount0Used,
                amount1Used: result.amount1Used
            })
        );
    }

    function _assertNoResidualBalance(
        MigrationParams calldata params,
        MigrationContext memory context
    ) private view {
        if (
            IERC20(params.token).balanceOf(address(this)) !=
            context.tokenBalanceBefore ||
            IERC20(params.quoteToken).balanceOf(address(this)) !=
            context.quoteBalanceBefore
        ) revert ResidualBalance();
    }

    function _validateSource(MigrationParams calldata params) private view {
        if (
            params.token == address(0) ||
            params.quoteToken != address(quoteToken) ||
            params.liquidityLocker == address(0) ||
            params.creatorFeeRecipient == address(0) ||
            params.tokenAmount == 0 ||
            params.quoteAmount == 0 ||
            params.creatorFeeShareBps != CREATOR_FEE_SHARE_BPS
        ) revert InvalidConfiguration();

        IArcOriginV6MigrationSource source = IArcOriginV6MigrationSource(msg.sender);
        IArcOriginFactoryLaunchRegistry.TokenInfo memory launch =
            IArcOriginFactoryLaunchRegistry(migrationController).getTokenInfo(params.token);
        if (
            launch.curve != msg.sender ||
            launch.token != params.token ||
            launch.creator != params.creatorFeeRecipient ||
            address(source.token()) != params.token ||
            address(source.usdc()) != params.quoteToken ||
            source.creatorFeeRecipient() != params.creatorFeeRecipient ||
            source.migrationController() != migrationController ||
            source.dexMigrationAdapter() != address(this) ||
            source.liquidityLocker() != params.liquidityLocker ||
            source.tokenReserve() != params.tokenAmount ||
            source.usdcReserve() != params.quoteAmount ||
            !source.isGraduated() ||
            source.isMigrated()
        ) revert UnauthorizedCurve();
    }
}
