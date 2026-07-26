// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ArcForgeFeeVault} from "./ArcForgeFeeVault.sol";
import {IArcForgeDexMigrationAdapter} from "./interfaces/IArcForgeDexMigrationAdapter.sol";

/// @notice ArcOrigin V5 constant-product launch curve with launch protection and optional DEX migration.
contract ArcForgeBondingCurveV5 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint16 public constant CREATOR_FEE_SHARE_BPS = 7_000;
    address public constant PERMANENT_LIQUIDITY_LOCK = 0x000000000000000000000000000000000000dEaD;
    bytes32 public constant BUY_FEE = keccak256("BUY_FEE");
    bytes32 public constant SELL_FEE = keccak256("SELL_FEE");

    IERC20 public immutable token;
    IERC20 public immutable usdc;
    ArcForgeFeeVault public immutable feeVault;
    address public immutable creatorFeeRecipient;
    address public immutable dexMigrationAdapter;
    address public immutable liquidityLocker;
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
    error MigrationFailed();

    constructor(CurveConfig memory config) {
        if (
            config.token == address(0) || config.usdc == address(0) || config.feeVault == address(0) ||
            config.creatorFeeRecipient == address(0)
        ) revert ZeroAddress();
        if (
            config.tokenReserve == 0 || config.virtualUsdcReserve == 0 || config.graduationThreshold == 0 ||
            config.buyFeeBps > 1_000 || config.sellFeeBps > 1_000 ||
            config.maxProtectionHoldingBps > BPS || config.maxProtectionPurchaseBps > BPS ||
            config.maxProtectionPurchaseBps < config.maxProtectionHoldingBps
        ) revert InvalidConfiguration();
        if (
            (config.dexMigrationAdapter == address(0)) != (config.liquidityLocker == address(0)) ||
            (config.dexMigrationAdapter != address(0) && config.dexMigrationAdapter.code.length == 0)
        ) revert InvalidConfiguration();

        token = IERC20(config.token);
        usdc = IERC20(config.usdc);
        feeVault = ArcForgeFeeVault(config.feeVault);
        creatorFeeRecipient = config.creatorFeeRecipient;
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

    function buy(uint256 usdcAmount, uint256 minTokensOut) external nonReentrant returns (uint256 tokensOut) {
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

        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        usdcReserve += usdcAmount - fee;
        tokenReserve -= tokensOut;
        _distributeFee(msg.sender, BUY_FEE, fee);
        token.safeTransfer(msg.sender, tokensOut);
        emit TokenBought(msg.sender, usdcAmount, tokensOut, fee);
        _checkGraduation();
    }

    function sell(uint256 tokenAmount, uint256 minUsdcOut) external nonReentrant returns (uint256 usdcOut) {
        if (migrated) revert TradingMigrated();
        if (tokenAmount == 0) revert ZeroAmount();
        uint256 fee;
        (usdcOut, fee) = quoteSell(tokenAmount);
        if (usdcOut == 0) revert InsufficientLiquidity();
        if (usdcOut < minUsdcOut) revert SlippageExceeded();

        token.safeTransferFrom(msg.sender, address(this), tokenAmount);
        uint256 grossOut = usdcOut + fee;
        usdcReserve -= grossOut;
        tokenReserve += tokenAmount;
        _distributeFee(msg.sender, SELL_FEE, fee);
        usdc.safeTransfer(msg.sender, usdcOut);
        emit TokenSold(msg.sender, tokenAmount, usdcOut, fee);
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

    function realLiquidity() external view returns (uint256) { return usdcReserve; }
    function effectiveUsdcReserve() external view returns (uint256) { return _effectiveUsdcReserve(); }
    function isGraduated() external view returns (bool) { return graduated; }
    function isMigrated() external view returns (bool) { return migrated; }

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

        if (dexMigrationAdapter != address(0)) {
            _migrateToDex(preGraduationTokenReserve);
            return;
        }

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

    function _migrateToDex(uint256 tokenLiquidity) private {
        address adapter = dexMigrationAdapter;
        uint256 quoteLiquidity = usdcReserve;
        token.forceApprove(adapter, tokenLiquidity);
        usdc.forceApprove(adapter, quoteLiquidity);
        (address pool, uint256 positionId) = IArcForgeDexMigrationAdapter(adapter).migrate(
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
        token.forceApprove(adapter, 0);
        usdc.forceApprove(adapter, 0);
        if (
            pool == address(0) || token.balanceOf(address(this)) != 0 ||
            usdc.balanceOf(address(this)) != 0
        ) revert MigrationFailed();

        tokenReserve = 0;
        usdcReserve = 0;
        migrated = true;
        migratedPool = pool;
        migratedPositionId = positionId;
        emit DexMigrationCompleted(adapter, pool, positionId, quoteLiquidity, tokenLiquidity);
    }

    function _effectiveUsdcReserve() private view returns (uint256) {
        return graduated ? usdcReserve : virtualUsdcReserve + usdcReserve;
    }

    function _distributeFee(address payer, bytes32 feeType, uint256 fee) private {
        if (fee == 0) return;
        uint256 protocolAmount = fee * (BPS - CREATOR_FEE_SHARE_BPS) / BPS;
        uint256 creatorAmount = fee - protocolAmount;
        totalCreatorFees += creatorAmount;
        totalProtocolFees += protocolAmount;
        if (creatorAmount != 0) usdc.safeTransfer(creatorFeeRecipient, creatorAmount);
        if (protocolAmount != 0) {
            usdc.forceApprove(address(feeVault), protocolAmount);
            feeVault.collectFee(address(usdc), payer, feeType, protocolAmount);
        }
        emit FeeCollected(payer, feeType, fee);
        emit FeeSplit(payer, feeType, creatorFeeRecipient, creatorAmount, protocolAmount);
    }
}
