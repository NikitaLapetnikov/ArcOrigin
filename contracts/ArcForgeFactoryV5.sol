// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ArcForgeToken} from "./ArcForgeToken.sol";
import {ArcForgeBondingCurveV5} from "./ArcForgeBondingCurveV5.sol";
import {ArcForgeFeeVault} from "./ArcForgeFeeVault.sol";
import {ArcForgeCreatorRegistry} from "./ArcForgeCreatorRegistry.sol";

contract ArcForgeFactoryV5 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;
    uint256 public constant GRADUATION_RESERVE_MULTIPLIER = 4;
    uint256 public constant MAX_NAME_BYTES = 64;
    uint256 public constant MAX_SYMBOL_BYTES = 10;
    uint256 public constant MAX_METADATA_URI_BYTES = 512;
    uint16 public constant CREATOR_FEE_SHARE_BPS = 7_000;
    bytes32 public constant LAUNCH_FEE = keccak256("LAUNCH_FEE");

    struct LaunchParams {
        string name;
        string symbol;
        string metadataURI;
    }

    struct TokenInfo {
        address token;
        address curve;
        address creator;
        uint64 launchedAt;
        string metadataURI;
    }

    IERC20 public immutable usdc;
    ArcForgeFeeVault public immutable feeVault;
    ArcForgeCreatorRegistry public immutable creatorRegistry;
    uint256 public launchFee;
    uint256 public virtualUsdcReserve;
    uint256 public graduationThreshold;
    uint16 public buyFeeBps;
    uint16 public sellFeeBps;
    uint16 public protectionBlocks;
    uint16 public maxProtectionHoldingBps;
    uint16 public maxProtectionPurchaseBps;
    address public dexMigrationAdapter;
    address public liquidityLocker;

    address[] private launchedTokens;
    mapping(address token => TokenInfo info) private tokenInfo;
    mapping(address creator => address[] tokens) private creatorTokens;

    event TokenLaunched(address indexed token, address indexed curve, address indexed creator, string name, string symbol);
    event LaunchFeePaid(address indexed creator, uint256 amount);
    event BondingCurveCreated(address indexed token, address indexed curve, uint256 graduationThreshold);
    event LaunchEconomicsUpdated(uint256 virtualUsdcReserve, uint256 graduationThreshold);
    event LaunchProtectionUpdated(uint16 protectionBlocks, uint16 holdingBps, uint16 purchaseBps);
    event MigrationConfigurationUpdated(address indexed adapter, address indexed liquidityLocker);
    event LaunchFeeUpdated(uint256 previousFee, uint256 newFee);
    event TradingFeesUpdated(uint16 buyFeeBps, uint16 sellFeeBps);

    error EmptyName();
    error EmptySymbol();
    error NameTooLong();
    error SymbolTooLong();
    error MetadataURITooLong();
    error InvalidConfiguration();

    constructor(
        address owner_,
        address usdc_,
        address feeVault_,
        address creatorRegistry_,
        uint256 launchFee_,
        uint256 virtualUsdcReserve_,
        uint256 graduationThreshold_
    ) Ownable(owner_) {
        if (
            usdc_ == address(0) || feeVault_ == address(0) || creatorRegistry_ == address(0) ||
            virtualUsdcReserve_ == 0 ||
            graduationThreshold_ != virtualUsdcReserve_ * GRADUATION_RESERVE_MULTIPLIER
        ) revert InvalidConfiguration();
        usdc = IERC20(usdc_);
        feeVault = ArcForgeFeeVault(feeVault_);
        creatorRegistry = ArcForgeCreatorRegistry(creatorRegistry_);
        launchFee = launchFee_;
        virtualUsdcReserve = virtualUsdcReserve_;
        graduationThreshold = graduationThreshold_;
        buyFeeBps = 100;
        sellFeeBps = 100;
        protectionBlocks = 3;
        maxProtectionHoldingBps = 500;
        maxProtectionPurchaseBps = 550;
    }

    function launchToken(LaunchParams calldata params) external nonReentrant returns (address token, address curve) {
        if (bytes(params.name).length == 0) revert EmptyName();
        if (bytes(params.symbol).length == 0) revert EmptySymbol();
        if (bytes(params.name).length > MAX_NAME_BYTES) revert NameTooLong();
        if (bytes(params.symbol).length > MAX_SYMBOL_BYTES) revert SymbolTooLong();
        if (bytes(params.metadataURI).length > MAX_METADATA_URI_BYTES) revert MetadataURITooLong();

        if (launchFee != 0) {
            usdc.safeTransferFrom(msg.sender, address(this), launchFee);
            usdc.forceApprove(address(feeVault), launchFee);
            feeVault.collectFee(address(usdc), msg.sender, LAUNCH_FEE, launchFee);
            emit LaunchFeePaid(msg.sender, launchFee);
        }

        ArcForgeToken launchedToken = new ArcForgeToken(
            params.name, params.symbol, TOTAL_SUPPLY, msg.sender, 0, params.metadataURI
        );
        ArcForgeBondingCurveV5 launchedCurve = new ArcForgeBondingCurveV5(
            ArcForgeBondingCurveV5.CurveConfig({
                token: address(launchedToken),
                usdc: address(usdc),
                feeVault: address(feeVault),
                creatorFeeRecipient: msg.sender,
                tokenReserve: TOTAL_SUPPLY,
                virtualUsdcReserve: virtualUsdcReserve,
                graduationThreshold: graduationThreshold,
                buyFeeBps: buyFeeBps,
                sellFeeBps: sellFeeBps,
                protectionBlocks: protectionBlocks,
                maxProtectionHoldingBps: maxProtectionHoldingBps,
                maxProtectionPurchaseBps: maxProtectionPurchaseBps,
                dexMigrationAdapter: dexMigrationAdapter,
                liquidityLocker: liquidityLocker
            })
        );
        IERC20(address(launchedToken)).safeTransfer(address(launchedCurve), TOTAL_SUPPLY);

        token = address(launchedToken);
        curve = address(launchedCurve);
        launchedTokens.push(token);
        creatorTokens[msg.sender].push(token);
        tokenInfo[token] = TokenInfo(token, curve, msg.sender, uint64(block.timestamp), params.metadataURI);
        creatorRegistry.recordLaunch(msg.sender, token);
        emit BondingCurveCreated(token, curve, graduationThreshold);
        emit TokenLaunched(token, curve, msg.sender, params.name, params.symbol);
    }

    function setLaunchFee(uint256 newFee) external onlyOwner {
        uint256 previous = launchFee;
        launchFee = newFee;
        emit LaunchFeeUpdated(previous, newFee);
    }

    function setTradingFees(uint16 newBuyFeeBps, uint16 newSellFeeBps) external onlyOwner {
        if (newBuyFeeBps > 1_000 || newSellFeeBps > 1_000) revert InvalidConfiguration();
        buyFeeBps = newBuyFeeBps;
        sellFeeBps = newSellFeeBps;
        emit TradingFeesUpdated(newBuyFeeBps, newSellFeeBps);
    }

    function setLaunchEconomics(uint256 newVirtualReserve, uint256 newGraduationThreshold) external onlyOwner {
        if (
            newVirtualReserve == 0 ||
            newGraduationThreshold != newVirtualReserve * GRADUATION_RESERVE_MULTIPLIER
        ) revert InvalidConfiguration();
        virtualUsdcReserve = newVirtualReserve;
        graduationThreshold = newGraduationThreshold;
        emit LaunchEconomicsUpdated(newVirtualReserve, newGraduationThreshold);
    }

    function setLaunchProtection(uint16 blocks_, uint16 holdingBps_, uint16 purchaseBps_) external onlyOwner {
        if (blocks_ > 100 || holdingBps_ > 1_000 || purchaseBps_ > 1_000 || purchaseBps_ < holdingBps_) {
            revert InvalidConfiguration();
        }
        protectionBlocks = blocks_;
        maxProtectionHoldingBps = holdingBps_;
        maxProtectionPurchaseBps = purchaseBps_;
        emit LaunchProtectionUpdated(blocks_, holdingBps_, purchaseBps_);
    }

    function setMigrationConfiguration(address adapter, address locker) external onlyOwner {
        if (
            (adapter == address(0)) != (locker == address(0)) ||
            (adapter != address(0) && adapter.code.length == 0)
        ) revert InvalidConfiguration();
        dexMigrationAdapter = adapter;
        liquidityLocker = locker;
        emit MigrationConfigurationUpdated(adapter, locker);
    }

    function getLaunchedTokens() external view returns (address[] memory) { return launchedTokens; }
    function getCreatorTokens(address creator) external view returns (address[] memory) { return creatorTokens[creator]; }
    function getTokenInfo(address token) external view returns (TokenInfo memory) { return tokenInfo[token]; }
}
