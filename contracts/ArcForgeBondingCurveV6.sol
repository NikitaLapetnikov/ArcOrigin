// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IArcForgeDexMigrationAdapter} from "./interfaces/IArcForgeDexMigrationAdapter.sol";
import {IArcForgeFeeVaultV6} from "./interfaces/IArcForgeFeeVaultV6.sol";
import {IArcForgeMigrationControllerV6} from "./interfaces/IArcForgeMigrationControllerV6.sol";
import {IArcForgeMigrationVerifierV6} from "./interfaces/IArcForgeMigrationVerifierV6.sol";

/// @notice ArcOrigin V6 constant-product curve with pull-based creator fees and fail-safe migration.
contract ArcForgeBondingCurveV6 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint16 public constant CREATOR_FEE_SHARE_BPS = 7_000;
    address public constant PERMANENT_LIQUIDITY_LOCK = 0x000000000000000000000000000000000000dEaD;
    bytes32 public constant BUY_FEE = keccak256("BUY_FEE");
    bytes32 public constant SELL_FEE = keccak256("SELL_FEE");

    IERC20 public immutable token;
    IERC20 public immutable usdc;
    IArcForgeFeeVaultV6 public immutable feeVault;
    address public immutable creatorFeeRecipient;
    address public immutable migrationController;
    address public immutable dexMigrationAdapter;
    address public immutable liquidityLocker;
    address public immutable migrationVerifier;
    bytes32 public immutable migrationConfigurationHash;
    bytes32 public immutable migrationAdapterCodeHash;
    bytes32 public immutable liquidityLockerCodeHash;
    bytes32 public immutable migrationVerifierCodeHash;
    uint256 public immutable initialTokenReserve;
    uint256 public immutable virtualUsdcReserve;
    uint256 public immutable graduationThreshold;
    uint16 public immutable buyFeeBps;
    uint16 public immutable sellFeeBps;
    uint64 public immutable launchBlock;
    uint64 public immutable protectionEndBlock;
    uint16 public immutable maxProtectionHoldingBps;
    uint16 public immutable maxProtectionPurchaseBps;

    uint256 public tokenReserve;
    uint256 public usdcReserve;
    uint256 public tokensSoldAtGraduation;
    uint256 public totalCreatorFees;
    uint256 public totalProtocolFees;
    uint256 public claimableCreatorFees;
    address public migratedPool;
    uint256 public migratedPositionId;
    bool private graduated;
    bool private migrated;
    mapping(address buyer => uint256 amount) public protectionPurchases;

    struct CurveConfig {
        address token;
        address usdc;
        address feeVault;
        address creatorFeeRecipient;
        address migrationController;
        uint256 tokenReserve;
        uint256 virtualUsdcReserve;
        uint256 graduationThreshold;
        uint16 buyFeeBps;
        uint16 sellFeeBps;
        uint16 protectionBlocks;
        uint16 maxProtectionHoldingBps;
        uint16 maxProtectionPurchaseBps;
        address dexMigrationAdapter;
        address liquidityLocker;
        address migrationVerifier;
        bytes32 migrationAdapterCodeHash;
        bytes32 liquidityLockerCodeHash;
        bytes32 migrationVerifierCodeHash;
    }

    event TokenBought(address indexed buyer, uint256 usdcIn, uint256 tokensOut, uint256 fee);
    event TokenSold(address indexed seller, uint256 tokensIn, uint256 usdcOut, uint256 fee);
    event FeeCollected(address indexed payer, bytes32 indexed feeType, uint256 amount);
    event FeeSplit(
        address indexed payer,
        bytes32 indexed feeType,
        address indexed creator,
        uint256 creatorAmount,
        uint256 protocolAmount
    );
    event CreatorFeesClaimed(address indexed creator, address indexed recipient, uint256 amount);
    event CurveGraduated(uint256 raisedUsdc, uint256 tokensSold);
    event PermanentLiquidityActivated(uint256 usdcLiquidity, uint256 tokenLiquidity, uint256 lockedTokens);
    event DexMigrationCompleted(
        address indexed adapter,
        address indexed pool,
        uint256 indexed positionId,
        uint256 usdcLiquidity,
        uint256 tokenLiquidity
    );

    error ZeroAddress();
    error InvalidConfiguration();
    error ZeroAmount();
    error SlippageExceeded();
    error InsufficientLiquidity();
    error GraduationThresholdExceeded(uint256 maxUsdcAmount);
    error ReserveNotFunded();
    error LaunchProtectionExceeded();
    error TradingMigrated();
    error AlreadyMigrated();
    error NotGraduated();
    error MigrationUnavailable();
    error MigrationFailed();
    error Unauthorized();
    error Expired();
    error UnsupportedTokenBehavior();

    constructor(CurveConfig memory config) {
        if (
            config.token == address(0) || config.usdc == address(0) || config.feeVault == address(0) ||
            config.creatorFeeRecipient == address(0) || config.migrationController == address(0)
        ) revert ZeroAddress();
        if (
            config.token.code.length == 0 || config.usdc.code.length == 0 ||
            config.feeVault.code.length == 0 || config.migrationController.code.length == 0 ||
            config.tokenReserve == 0 || config.virtualUsdcReserve == 0 || config.graduationThreshold == 0 ||
            config.buyFeeBps > 1_000 || config.sellFeeBps > 1_000 ||
            config.maxProtectionHoldingBps > BPS || config.maxProtectionPurchaseBps > BPS ||
            config.maxProtectionPurchaseBps < config.maxProtectionHoldingBps
        ) revert InvalidConfiguration();

        bool migrationDisabled =
            config.dexMigrationAdapter == address(0) &&
            config.liquidityLocker == address(0) &&
            config.migrationVerifier == address(0) &&
            config.migrationAdapterCodeHash == bytes32(0) &&
            config.liquidityLockerCodeHash == bytes32(0) &&
            config.migrationVerifierCodeHash == bytes32(0);
        if (!migrationDisabled) {
            if (
                config.dexMigrationAdapter == address(0) || config.liquidityLocker == address(0) ||
                config.migrationVerifier == address(0) ||
                config.dexMigrationAdapter.codehash != config.migrationAdapterCodeHash ||
                config.liquidityLocker.codehash != config.liquidityLockerCodeHash ||
                config.migrationVerifier.codehash != config.migrationVerifierCodeHash
            ) revert InvalidConfiguration();
        }

        token = IERC20(config.token);
        usdc = IERC20(config.usdc);
        feeVault = IArcForgeFeeVaultV6(config.feeVault);
        creatorFeeRecipient = config.creatorFeeRecipient;
        migrationController = config.migrationController;
        initialTokenReserve = config.tokenReserve;
        tokenReserve = config.tokenReserve;
        virtualUsdcReserve = config.virtualUsdcReserve;
        graduationThreshold = config.graduationThreshold;
        buyFeeBps = config.buyFeeBps;
        sellFeeBps = config.sellFeeBps;
        launchBlock = uint64(block.number);
        protectionEndBlock = uint64(block.number + config.protectionBlocks);
        maxProtectionHoldingBps = config.maxProtectionHoldingBps;
        maxProtectionPurchaseBps = config.maxProtectionPurchaseBps;
        dexMigrationAdapter = config.dexMigrationAdapter;
        liquidityLocker = config.liquidityLocker;
        migrationVerifier = config.migrationVerifier;
        migrationAdapterCodeHash = config.migrationAdapterCodeHash;
        liquidityLockerCodeHash = config.liquidityLockerCodeHash;
        migrationVerifierCodeHash = config.migrationVerifierCodeHash;
        migrationConfigurationHash = migrationDisabled
            ? bytes32(0)
            : keccak256(
                abi.encode(
                    config.dexMigrationAdapter,
                    config.liquidityLocker,
                    config.migrationVerifier,
                    config.migrationAdapterCodeHash,
                    config.liquidityLockerCodeHash,
                    config.migrationVerifierCodeHash
                )
            );
    }

    function quoteBuy(uint256 usdcAmount) public view returns (uint256 tokensOut, uint256 fee) {
        if (usdcAmount == 0 || migrated) return (0, 0);
        if (!graduated && usdcAmount > maxBuyAmount()) return (0, 0);
        fee = usdcAmount * buyFeeBps / BPS;
        uint256 netAmount = usdcAmount - fee;
        uint256 currentUsdc = _effectiveUsdcReserve();
        uint256 newTokenReserve = Math.mulDiv(
            currentUsdc, tokenReserve, currentUsdc + netAmount, Math.Rounding.Ceil
        );
        if (newTokenReserve == 0) return (0, fee);
        tokensOut = tokenReserve - newTokenReserve;
    }

    function quoteSell(uint256 tokenAmount) public view returns (uint256 usdcOut, uint256 fee) {
        if (tokenAmount == 0 || migrated) return (0, 0);
        uint256 currentUsdc = _effectiveUsdcReserve();
        uint256 newUsdc = Math.mulDiv(
            currentUsdc, tokenReserve, tokenReserve + tokenAmount, Math.Rounding.Ceil
        );
        uint256 grossOut = currentUsdc - newUsdc;
        if (grossOut > usdcReserve) return (0, 0);
        fee = grossOut * sellFeeBps / BPS;
        usdcOut = grossOut - fee;
    }

    function buy(
        uint256 usdcAmount,
        uint256 minTokensOut,
        uint256 deadline
    ) external nonReentrant returns (uint256 tokensOut) {
        if (block.timestamp > deadline) revert Expired();
        if (migrated) revert TradingMigrated();
        if (usdcAmount == 0) revert ZeroAmount();
        if (!graduated) {
            uint256 maximum = maxBuyAmount();
            if (usdcAmount > maximum) revert GraduationThresholdExceeded(maximum);
        }
        if (token.balanceOf(address(this)) < tokenReserve) revert ReserveNotFunded();
        uint256 fee;
        (tokensOut, fee) = quoteBuy(usdcAmount);
        if (tokensOut == 0 || tokensOut < minTokensOut) revert SlippageExceeded();
        _enforceLaunchProtection(msg.sender, tokensOut);

        uint256 balanceBefore = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        if (usdc.balanceOf(address(this)) - balanceBefore != usdcAmount) {
            revert UnsupportedTokenBehavior();
        }

        usdcReserve += usdcAmount - fee;
        tokenReserve -= tokensOut;
        _accrueFee(msg.sender, BUY_FEE, fee);
        token.safeTransfer(msg.sender, tokensOut);
        emit TokenBought(msg.sender, usdcAmount, tokensOut, fee);
        _checkGraduation();
    }

    function sell(
        uint256 tokenAmount,
        uint256 minUsdcOut,
        uint256 deadline
    ) external nonReentrant returns (uint256 usdcOut) {
        if (block.timestamp > deadline) revert Expired();
        if (migrated) revert TradingMigrated();
        if (tokenAmount == 0) revert ZeroAmount();
        uint256 fee;
        (usdcOut, fee) = quoteSell(tokenAmount);
        if (usdcOut == 0) revert InsufficientLiquidity();
        if (usdcOut < minUsdcOut) revert SlippageExceeded();

        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), tokenAmount);
        if (token.balanceOf(address(this)) - balanceBefore != tokenAmount) {
            revert UnsupportedTokenBehavior();
        }

        uint256 grossOut = usdcOut + fee;
        usdcReserve -= grossOut;
        tokenReserve += tokenAmount;
        _accrueFee(msg.sender, SELL_FEE, fee);
        usdc.safeTransfer(msg.sender, usdcOut);
        emit TokenSold(msg.sender, tokenAmount, usdcOut, fee);
    }

    function claimCreatorFees(address recipient) external nonReentrant returns (uint256 amount) {
        if (msg.sender != creatorFeeRecipient) revert Unauthorized();
        if (recipient == address(0)) revert ZeroAddress();
        amount = claimableCreatorFees;
        if (amount == 0) revert ZeroAmount();
        claimableCreatorFees = 0;
        usdc.safeTransfer(recipient, amount);
        emit CreatorFeesClaimed(msg.sender, recipient, amount);
    }

    /// @notice Optional migration is decoupled from graduation, so a failed external DEX
    ///         cannot block the final buy or disable the internal permanent AMM.
    function migrateToDex() external nonReentrant {
        if (!graduated) revert NotGraduated();
        if (migrated) revert AlreadyMigrated();
        bytes32 configurationHash = migrationConfigurationHash;
        if (
            configurationHash == bytes32(0) ||
            !IArcForgeMigrationControllerV6(migrationController)
                .isMigrationConfigurationApproved(configurationHash)
        ) revert MigrationUnavailable();
        if (
            dexMigrationAdapter.codehash != migrationAdapterCodeHash ||
            liquidityLocker.codehash != liquidityLockerCodeHash ||
            migrationVerifier.codehash != migrationVerifierCodeHash
        ) revert MigrationUnavailable();

        uint256 tokenLiquidity = tokenReserve;
        uint256 quoteLiquidity = usdcReserve;
        if (tokenLiquidity == 0 || quoteLiquidity == 0) revert InsufficientLiquidity();
        uint256 tokenBalanceBefore = token.balanceOf(address(this));
        uint256 quoteBalanceBefore = usdc.balanceOf(address(this));
        if (tokenBalanceBefore < tokenLiquidity || quoteBalanceBefore < quoteLiquidity) {
            revert ReserveNotFunded();
        }

        token.forceApprove(dexMigrationAdapter, tokenLiquidity);
        usdc.forceApprove(dexMigrationAdapter, quoteLiquidity);
        (address pool, uint256 positionId) = IArcForgeDexMigrationAdapter(dexMigrationAdapter).migrate(
            IArcForgeDexMigrationAdapter.MigrationParams({
                token: address(token),
                quoteToken: address(usdc),
                tokenAmount: tokenLiquidity,
                quoteAmount: quoteLiquidity,
                liquidityLocker: liquidityLocker,
                creatorFeeRecipient: creatorFeeRecipient,
                creatorFeeShareBps: CREATOR_FEE_SHARE_BPS
            })
        );
        token.forceApprove(dexMigrationAdapter, 0);
        usdc.forceApprove(dexMigrationAdapter, 0);

        uint256 tokenBalanceAfter = token.balanceOf(address(this));
        uint256 quoteBalanceAfter = usdc.balanceOf(address(this));
        if (
            pool.code.length == 0 ||
            dexMigrationAdapter.codehash != migrationAdapterCodeHash ||
            tokenBalanceAfter > tokenBalanceBefore ||
            quoteBalanceAfter > quoteBalanceBefore ||
            tokenBalanceBefore - tokenBalanceAfter != tokenLiquidity ||
            quoteBalanceBefore - quoteBalanceAfter != quoteLiquidity
        ) revert MigrationFailed();

        bool verified = IArcForgeMigrationVerifierV6(migrationVerifier).verifyMigration(
            IArcForgeMigrationVerifierV6.VerificationParams({
                adapter: dexMigrationAdapter,
                token: address(token),
                quoteToken: address(usdc),
                pool: pool,
                liquidityLocker: liquidityLocker,
                positionId: positionId,
                tokenAmount: tokenLiquidity,
                quoteAmount: quoteLiquidity
            })
        );
        if (!verified) revert MigrationFailed();

        tokenReserve = 0;
        usdcReserve = 0;
        migrated = true;
        migratedPool = pool;
        migratedPositionId = positionId;
        emit DexMigrationCompleted(
            dexMigrationAdapter,
            pool,
            positionId,
            quoteLiquidity,
            tokenLiquidity
        );
    }

    function getCurrentPrice() external view returns (uint256 usdcPerWholeToken) {
        if (migrated || tokenReserve == 0) return 0;
        return Math.mulDiv(_effectiveUsdcReserve(), 1e18, tokenReserve);
    }

    function getCurveProgress() external view returns (uint256 progressBps) {
        if (graduated) return BPS;
        uint256 progress = usdcReserve * BPS / graduationThreshold;
        return progress > BPS ? BPS : progress;
    }

    function tokensSold() public view returns (uint256) {
        if (graduated) return tokensSoldAtGraduation;
        return tokenReserve < initialTokenReserve ? initialTokenReserve - tokenReserve : 0;
    }

    function realLiquidity() external view returns (uint256) {
        return usdcReserve;
    }

    function effectiveUsdcReserve() external view returns (uint256) {
        return _effectiveUsdcReserve();
    }

    function isGraduated() external view returns (bool) {
        return graduated;
    }

    function isMigrated() external view returns (bool) {
        return migrated;
    }

    function maxBuyAmount() public view returns (uint256) {
        if (graduated) return type(uint256).max;
        if (usdcReserve >= graduationThreshold) return 0;
        uint256 remainingNetUsdc = graduationThreshold - usdcReserve;
        return Math.mulDiv(remainingNetUsdc, BPS, BPS - buyFeeBps);
    }

    function _enforceLaunchProtection(address buyer, uint256 tokensOut) private {
        if (block.number > protectionEndBlock) return;
        uint256 purchaseLimit = initialTokenReserve * maxProtectionPurchaseBps / BPS;
        uint256 holdingLimit = initialTokenReserve * maxProtectionHoldingBps / BPS;
        uint256 nextPurchased = protectionPurchases[buyer] + tokensOut;
        if (nextPurchased > purchaseLimit || token.balanceOf(buyer) + tokensOut > holdingLimit) {
            revert LaunchProtectionExceeded();
        }
        protectionPurchases[buyer] = nextPurchased;
    }

    function _checkGraduation() private {
        if (graduated || usdcReserve < graduationThreshold) return;
        uint256 preGraduationTokenReserve = tokenReserve;
        tokensSoldAtGraduation = initialTokenReserve - preGraduationTokenReserve;
        graduated = true;
        emit CurveGraduated(usdcReserve, tokensSoldAtGraduation);

        uint256 effectiveUsdc = virtualUsdcReserve + usdcReserve;
        uint256 permanentTokenLiquidity = Math.mulDiv(
            usdcReserve, preGraduationTokenReserve, effectiveUsdc, Math.Rounding.Ceil
        );
        if (permanentTokenLiquidity == 0 || permanentTokenLiquidity >= preGraduationTokenReserve) {
            revert InvalidConfiguration();
        }
        uint256 lockedTokens = preGraduationTokenReserve - permanentTokenLiquidity;
        tokenReserve = permanentTokenLiquidity;
        token.safeTransfer(PERMANENT_LIQUIDITY_LOCK, lockedTokens);
        emit PermanentLiquidityActivated(usdcReserve, permanentTokenLiquidity, lockedTokens);
    }

    function _effectiveUsdcReserve() private view returns (uint256) {
        return graduated ? usdcReserve : virtualUsdcReserve + usdcReserve;
    }

    function _accrueFee(address payer, bytes32 feeType, uint256 fee) private {
        if (fee == 0) return;
        uint256 protocolAmount = fee * (BPS - CREATOR_FEE_SHARE_BPS) / BPS;
        uint256 creatorAmount = fee - protocolAmount;
        totalCreatorFees += creatorAmount;
        totalProtocolFees += protocolAmount;
        claimableCreatorFees += creatorAmount;
        if (protocolAmount != 0) {
            usdc.forceApprove(address(feeVault), protocolAmount);
            feeVault.collectFee(address(usdc), payer, feeType, protocolAmount);
            usdc.forceApprove(address(feeVault), 0);
        }
        emit FeeCollected(payer, feeType, fee);
        emit FeeSplit(payer, feeType, creatorFeeRecipient, creatorAmount, protocolAmount);
    }
}
