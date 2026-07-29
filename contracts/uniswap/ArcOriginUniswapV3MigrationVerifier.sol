// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IArcForgeMigrationVerifierV6} from "../interfaces/IArcForgeMigrationVerifierV6.sol";
import {
    IUniswapV3FactoryMinimal,
    IUniswapV3PoolMinimal,
    INonfungiblePositionManagerMinimal
} from "../interfaces/IUniswapV3Minimal.sol";
import {IArcOriginUniswapV3Locker} from "../interfaces/IArcOriginUniswapV3Locker.sol";
import {ArcOriginUniswapV3LiquidityLocker} from "./ArcOriginUniswapV3LiquidityLocker.sol";
import {ArcOriginUniswapV3MigrationAdapter} from "./ArcOriginUniswapV3MigrationAdapter.sol";
import {ArcOriginUniswapV3Math} from "./ArcOriginUniswapV3Math.sol";

interface IArcOriginFactoryMigrationRegistry {
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

/// @notice Independently validates every ArcOrigin V3 migration before a curve
///         permanently disables internal trading.
contract ArcOriginUniswapV3MigrationVerifier is IArcForgeMigrationVerifierV6 {
    uint16 public constant BPS = 10_000;

    address public immutable migrationController;
    IUniswapV3FactoryMinimal public immutable v3Factory;
    INonfungiblePositionManagerMinimal public immutable positionManager;
    IERC20 public immutable quoteToken;
    ArcOriginUniswapV3MigrationAdapter public immutable adapter;
    ArcOriginUniswapV3LiquidityLocker public immutable locker;

    struct VerificationContext {
        address token0;
        address token1;
        address creator;
        uint256 principal0;
        uint256 principal1;
        uint128 positionLiquidity;
        uint256 amount0Used;
        uint256 amount1Used;
    }

    error ZeroAddress();
    error InvalidConfiguration();

    constructor(
        address migrationController_,
        address v3Factory_,
        address positionManager_,
        address quoteToken_,
        address adapter_,
        address locker_
    ) {
        if (
            migrationController_ == address(0) ||
            v3Factory_ == address(0) ||
            positionManager_ == address(0) ||
            quoteToken_ == address(0) ||
            adapter_ == address(0) ||
            locker_ == address(0)
        ) revert ZeroAddress();
        if (
            migrationController_.code.length == 0 ||
            v3Factory_.code.length == 0 ||
            positionManager_.code.length == 0 ||
            quoteToken_.code.length == 0 ||
            adapter_.code.length == 0 ||
            locker_.code.length == 0
        ) revert InvalidConfiguration();
        migrationController = migrationController_;
        v3Factory = IUniswapV3FactoryMinimal(v3Factory_);
        positionManager = INonfungiblePositionManagerMinimal(positionManager_);
        quoteToken = IERC20(quoteToken_);
        adapter = ArcOriginUniswapV3MigrationAdapter(adapter_);
        locker = ArcOriginUniswapV3LiquidityLocker(locker_);
    }

    function verifyMigration(
        VerificationParams calldata params
    ) external view returns (bool) {
        if (!_validParameters(params) || !_validBindings()) return false;

        VerificationContext memory context;
        try
            IArcOriginFactoryMigrationRegistry(migrationController).getTokenInfo(
                params.token
            )
        returns (IArcOriginFactoryMigrationRegistry.TokenInfo memory launch) {
            if (
                launch.token != params.token ||
                launch.curve != msg.sender ||
                launch.creator == address(0)
            ) return false;
            context.creator = launch.creator;
        } catch {
            return false;
        }

        (
            context.token0,
            context.token1,
            context.principal0,
            context.principal1
        ) = ArcOriginUniswapV3Math.sortTokens(
            params.token,
            params.quoteToken,
            params.tokenAmount,
            params.quoteAmount
        );
        if (
            v3Factory.getPool(
                context.token0,
                context.token1,
                adapter.POOL_FEE()
            ) != params.pool ||
            params.pool.code.length == 0
        ) return false;

        try positionManager.ownerOf(params.positionId) returns (address owner) {
            if (owner != address(locker)) return false;
        } catch {
            return false;
        }

        context.positionLiquidity = _verifiedPositionLiquidity(
            params.positionId,
            context
        );
        if (context.positionLiquidity == 0) return false;

        IArcOriginUniswapV3Locker.PositionRecordParams memory record =
            locker.getPositionRecord(params.positionId);
        context.amount0Used = record.amount0Used;
        context.amount1Used = record.amount1Used;
        if (!_validLockRecord(params, context, record)) return false;
        if (!_validPool(params.pool, context)) return false;

        uint256 dust0 = context.principal0 - context.amount0Used;
        uint256 dust1 = context.principal1 - context.amount1Used;
        if (
            IERC20(context.token0).balanceOf(address(locker)) < dust0 ||
            IERC20(context.token1).balanceOf(address(locker)) < dust1
        ) return false;
        return true;
    }

    function _validParameters(
        VerificationParams calldata params
    ) private view returns (bool) {
        return
            params.adapter == address(adapter) &&
            params.quoteToken == address(quoteToken) &&
            params.liquidityLocker == address(locker) &&
            params.token != address(0) &&
            params.pool != address(0) &&
            params.positionId != 0 &&
            params.tokenAmount != 0 &&
            params.quoteAmount != 0;
    }

    function _validBindings() private view returns (bool) {
        return
            adapter.migrationController() == migrationController &&
            address(adapter.v3Factory()) == address(v3Factory) &&
            address(adapter.positionManager()) == address(positionManager) &&
            address(adapter.quoteToken()) == address(quoteToken) &&
            locker.adapter() == address(adapter) &&
            locker.positionManager() == address(positionManager) &&
            locker.protocolFeeRecipient() ==
            IArcOriginFactoryMigrationRegistry(migrationController).feeVault();
    }

    function _verifiedPositionLiquidity(
        uint256 positionId,
        VerificationContext memory context
    ) private view returns (uint128 verifiedLiquidity) {
        try positionManager.positions(positionId) returns (
            uint96,
            address,
            address positionToken0,
            address positionToken1,
            uint24 positionFee,
            int24 positionTickLower,
            int24 positionTickUpper,
            uint128 liquidity,
            uint256,
            uint256,
            uint128,
            uint128
        ) {
            if (
                positionToken0 != context.token0 ||
                positionToken1 != context.token1 ||
                positionFee != adapter.POOL_FEE() ||
                positionTickLower != adapter.tickLower() ||
                positionTickUpper != adapter.tickUpper() ||
                liquidity == 0
            ) return 0;
            return liquidity;
        } catch {
            return 0;
        }
    }

    function _validLockRecord(
        VerificationParams calldata params,
        VerificationContext memory context,
        IArcOriginUniswapV3Locker.PositionRecordParams memory record
    ) private view returns (bool) {
        return
            record.positionId == params.positionId &&
            record.pool == params.pool &&
            record.token0 == context.token0 &&
            record.token1 == context.token1 &&
            record.creatorFeeRecipient == context.creator &&
            record.creatorFeeShareBps == adapter.CREATOR_FEE_SHARE_BPS() &&
            record.fee == adapter.POOL_FEE() &&
            record.tickLower == adapter.tickLower() &&
            record.tickUpper == adapter.tickUpper() &&
            record.liquidity == context.positionLiquidity &&
            record.principal0 == context.principal0 &&
            record.principal1 == context.principal1 &&
            record.amount0Used <= context.principal0 &&
            record.amount1Used <= context.principal1 &&
            record.amount0Used * BPS >=
            context.principal0 * adapter.MIN_LIQUIDITY_USAGE_BPS() &&
            record.amount1Used * BPS >=
            context.principal1 * adapter.MIN_LIQUIDITY_USAGE_BPS();
    }

    function _validPool(
        address poolAddress,
        VerificationContext memory context
    ) private view returns (bool) {
        IUniswapV3PoolMinimal pool = IUniswapV3PoolMinimal(poolAddress);
        if (
            pool.factory() != address(v3Factory) ||
            pool.token0() != context.token0 ||
            pool.token1() != context.token1 ||
            pool.fee() != adapter.POOL_FEE() ||
            pool.liquidity() != context.positionLiquidity
        ) return false;
        (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();
        return
            sqrtPriceX96 ==
            ArcOriginUniswapV3Math.encodeSqrtRatioX96(
                context.principal0,
                context.principal1
            );
    }
}
