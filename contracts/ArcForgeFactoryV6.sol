// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ArcForgeToken} from "./ArcForgeToken.sol";
import {ArcForgeBondingCurveV6} from "./ArcForgeBondingCurveV6.sol";
import {ArcForgeCurveDeployerV6} from "./ArcForgeCurveDeployerV6.sol";
import {ArcForgeFeeVaultV6} from "./ArcForgeFeeVaultV6.sol";
import {ArcForgeCreatorRegistryV6} from "./ArcForgeCreatorRegistryV6.sol";
import {IArcForgeMigrationControllerV6} from "./interfaces/IArcForgeMigrationControllerV6.sol";

/// @notice Canonical, bounded ArcOrigin V6 launch factory.
contract ArcForgeFactoryV6 is
    Ownable2Step,
    Pausable,
    ReentrancyGuard,
    IArcForgeMigrationControllerV6
{
    using SafeERC20 for IERC20;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;
    uint256 public constant GRADUATION_RESERVE_MULTIPLIER = 4;
    uint256 public constant MAX_NAME_BYTES = 64;
    uint256 public constant MAX_SYMBOL_BYTES = 10;
    uint256 public constant MAX_METADATA_URI_BYTES = 512;
    uint256 public constant MAX_LAUNCH_FEE = 100 * 1e6;
    uint256 public constant MAX_PAGE_SIZE = 100;
    uint16 public constant MAX_TRADING_FEE_BPS = 200;
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
    ArcForgeFeeVaultV6 public immutable feeVault;
    ArcForgeCreatorRegistryV6 public immutable creatorRegistry;
    ArcForgeCurveDeployerV6 public immutable curveDeployer;
    uint256 public launchFee;
    uint256 public virtualUsdcReserve;
    uint256 public graduationThreshold;
    uint16 public buyFeeBps;
    uint16 public sellFeeBps;
    uint16 public protectionBlocks;
    uint16 public maxProtectionHoldingBps;
    uint16 public maxProtectionPurchaseBps;
    address public emergencyGuardian;
    address public dexMigrationAdapter;
    address public liquidityLocker;
    address public migrationVerifier;
    bytes32 public migrationAdapterCodeHash;
    bytes32 public liquidityLockerCodeHash;
    bytes32 public migrationVerifierCodeHash;
    bytes32 public currentMigrationConfigurationHash;
    bool public migrationPaused;

    address[] private launchedTokens;
    mapping(address token => TokenInfo info) private tokenInfo;
    mapping(address creator => address[] tokens) private creatorTokens;

    event TokenLaunched(
        address indexed token,
        address indexed curve,
        address indexed creator,
        string name,
        string symbol
    );
    event LaunchFeePaid(address indexed creator, uint256 amount);
    event BondingCurveCreated(address indexed token, address indexed curve, uint256 graduationThreshold);
    event LaunchEconomicsUpdated(uint256 virtualUsdcReserve, uint256 graduationThreshold);
    event LaunchProtectionUpdated(uint16 protectionBlocks, uint16 holdingBps, uint16 purchaseBps);
    event MigrationConfigurationUpdated(
        address indexed adapter,
        address indexed liquidityLocker,
        address indexed verifier,
        bytes32 configurationHash
    );
    event MigrationPauseUpdated(bool paused);
    event EmergencyGuardianUpdated(address indexed previousGuardian, address indexed newGuardian);
    event LaunchFeeUpdated(uint256 previousFee, uint256 newFee);
    event TradingFeesUpdated(uint16 buyFeeBps, uint16 sellFeeBps);

    error EmptyName();
    error EmptySymbol();
    error NameTooLong();
    error SymbolTooLong();
    error MetadataURITooLong();
    error InvalidConfiguration();
    error InvalidPage();
    error Unauthorized();
    error UnsupportedTokenBehavior();
    error RenounceDisabled();

    constructor(
        address owner_,
        address emergencyGuardian_,
        address usdc_,
        address feeVault_,
        address creatorRegistry_,
        address curveDeployer_,
        uint256 launchFee_,
        uint256 virtualUsdcReserve_,
        uint256 graduationThreshold_
    ) Ownable(owner_) {
        if (
            owner_ == address(0) || emergencyGuardian_ == address(0) ||
            usdc_ == address(0) || feeVault_ == address(0) ||
            creatorRegistry_ == address(0) || curveDeployer_ == address(0)
        ) revert InvalidConfiguration();
        if (
            usdc_.code.length == 0 || feeVault_.code.length == 0 ||
            creatorRegistry_.code.length == 0 || curveDeployer_.code.length == 0 ||
            IERC20Metadata(usdc_).decimals() != 6 ||
            launchFee_ > MAX_LAUNCH_FEE ||
            virtualUsdcReserve_ == 0 ||
            graduationThreshold_ != virtualUsdcReserve_ * GRADUATION_RESERVE_MULTIPLIER
        ) revert InvalidConfiguration();

        usdc = IERC20(usdc_);
        feeVault = ArcForgeFeeVaultV6(feeVault_);
        creatorRegistry = ArcForgeCreatorRegistryV6(creatorRegistry_);
        curveDeployer = ArcForgeCurveDeployerV6(curveDeployer_);
        emergencyGuardian = emergencyGuardian_;
        launchFee = launchFee_;
        virtualUsdcReserve = virtualUsdcReserve_;
        graduationThreshold = graduationThreshold_;
        buyFeeBps = 100;
        sellFeeBps = 100;
        protectionBlocks = 3;
        maxProtectionHoldingBps = 500;
        maxProtectionPurchaseBps = 550;
        migrationPaused = true;
    }

    function launchToken(
        LaunchParams calldata params
    ) external whenNotPaused nonReentrant returns (address token, address curve) {
        _validateLaunch(params);
        _collectLaunchFee(msg.sender);

        ArcForgeToken launchedToken = new ArcForgeToken(
            params.name,
            params.symbol,
            TOTAL_SUPPLY,
            msg.sender,
            0,
            params.metadataURI
        );
        ArcForgeBondingCurveV6.CurveConfig memory curveConfig = ArcForgeBondingCurveV6.CurveConfig({
            token: address(launchedToken),
            usdc: address(usdc),
            feeVault: address(feeVault),
            creatorFeeRecipient: msg.sender,
            migrationController: address(this),
            tokenReserve: TOTAL_SUPPLY,
            virtualUsdcReserve: virtualUsdcReserve,
            graduationThreshold: graduationThreshold,
            buyFeeBps: buyFeeBps,
            sellFeeBps: sellFeeBps,
            protectionBlocks: protectionBlocks,
            maxProtectionHoldingBps: maxProtectionHoldingBps,
            maxProtectionPurchaseBps: maxProtectionPurchaseBps,
            dexMigrationAdapter: dexMigrationAdapter,
            liquidityLocker: liquidityLocker,
            migrationVerifier: migrationVerifier,
            migrationAdapterCodeHash: migrationAdapterCodeHash,
            liquidityLockerCodeHash: liquidityLockerCodeHash,
            migrationVerifierCodeHash: migrationVerifierCodeHash
        });
        curve = curveDeployer.deployCurve(curveConfig);
        feeVault.setCollector(curve, true);
        IERC20(address(launchedToken)).safeTransfer(curve, TOTAL_SUPPLY);

        token = address(launchedToken);
        launchedTokens.push(token);
        creatorTokens[msg.sender].push(token);
        tokenInfo[token] = TokenInfo(token, curve, msg.sender, uint64(block.timestamp), params.metadataURI);
        creatorRegistry.recordLaunch(msg.sender, token);
        emit BondingCurveCreated(token, curve, graduationThreshold);
        emit TokenLaunched(token, curve, msg.sender, params.name, params.symbol);
    }

    function setLaunchFee(uint256 newFee) external onlyOwner {
        if (newFee > MAX_LAUNCH_FEE) revert InvalidConfiguration();
        uint256 previous = launchFee;
        launchFee = newFee;
        emit LaunchFeeUpdated(previous, newFee);
    }

    function setTradingFees(uint16 newBuyFeeBps, uint16 newSellFeeBps) external onlyOwner {
        if (newBuyFeeBps > MAX_TRADING_FEE_BPS || newSellFeeBps > MAX_TRADING_FEE_BPS) {
            revert InvalidConfiguration();
        }
        buyFeeBps = newBuyFeeBps;
        sellFeeBps = newSellFeeBps;
        emit TradingFeesUpdated(newBuyFeeBps, newSellFeeBps);
    }

    function setLaunchEconomics(
        uint256 newVirtualReserve,
        uint256 newGraduationThreshold
    ) external onlyOwner {
        if (
            newVirtualReserve == 0 ||
            newGraduationThreshold != newVirtualReserve * GRADUATION_RESERVE_MULTIPLIER
        ) revert InvalidConfiguration();
        virtualUsdcReserve = newVirtualReserve;
        graduationThreshold = newGraduationThreshold;
        emit LaunchEconomicsUpdated(newVirtualReserve, newGraduationThreshold);
    }

    function setLaunchProtection(
        uint16 blocks_,
        uint16 holdingBps_,
        uint16 purchaseBps_
    ) external onlyOwner {
        if (
            blocks_ > 100 || holdingBps_ > 1_000 ||
            purchaseBps_ > 1_000 || purchaseBps_ < holdingBps_
        ) revert InvalidConfiguration();
        protectionBlocks = blocks_;
        maxProtectionHoldingBps = holdingBps_;
        maxProtectionPurchaseBps = purchaseBps_;
        emit LaunchProtectionUpdated(blocks_, holdingBps_, purchaseBps_);
    }

    /// @notice Configuring a new tuple automatically revokes every older tuple.
    function setMigrationConfiguration(
        address adapter,
        address locker,
        address verifier
    ) external onlyOwner {
        if (
            adapter == address(0) || locker == address(0) || verifier == address(0) ||
            adapter.code.length == 0 || locker.code.length == 0 || verifier.code.length == 0
        ) revert InvalidConfiguration();

        bytes32 adapterHash = adapter.codehash;
        bytes32 lockerHash = locker.codehash;
        bytes32 verifierHash = verifier.codehash;
        bytes32 configurationHash = keccak256(
            abi.encode(adapter, locker, verifier, adapterHash, lockerHash, verifierHash)
        );
        dexMigrationAdapter = adapter;
        liquidityLocker = locker;
        migrationVerifier = verifier;
        migrationAdapterCodeHash = adapterHash;
        liquidityLockerCodeHash = lockerHash;
        migrationVerifierCodeHash = verifierHash;
        currentMigrationConfigurationHash = configurationHash;
        migrationPaused = true;
        emit MigrationConfigurationUpdated(adapter, locker, verifier, configurationHash);
        emit MigrationPauseUpdated(true);
    }

    function disableMigrationConfiguration() external onlyOwner {
        dexMigrationAdapter = address(0);
        liquidityLocker = address(0);
        migrationVerifier = address(0);
        migrationAdapterCodeHash = bytes32(0);
        liquidityLockerCodeHash = bytes32(0);
        migrationVerifierCodeHash = bytes32(0);
        currentMigrationConfigurationHash = bytes32(0);
        migrationPaused = true;
        emit MigrationConfigurationUpdated(address(0), address(0), address(0), bytes32(0));
        emit MigrationPauseUpdated(true);
    }

    function pauseLaunches() external {
        _requireOwnerOrGuardian();
        _pause();
    }

    function unpauseLaunches() external onlyOwner {
        _unpause();
    }

    function pauseMigrations() external {
        _requireOwnerOrGuardian();
        if (!migrationPaused) {
            migrationPaused = true;
            emit MigrationPauseUpdated(true);
        }
    }

    function unpauseMigrations() external onlyOwner {
        if (currentMigrationConfigurationHash == bytes32(0)) revert InvalidConfiguration();
        migrationPaused = false;
        emit MigrationPauseUpdated(false);
    }

    function setEmergencyGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert InvalidConfiguration();
        address previous = emergencyGuardian;
        emergencyGuardian = newGuardian;
        emit EmergencyGuardianUpdated(previous, newGuardian);
    }

    function isMigrationConfigurationApproved(
        bytes32 configurationHash
    ) external view returns (bool) {
        return (
            !migrationPaused &&
            configurationHash != bytes32(0) &&
            configurationHash == currentMigrationConfigurationHash
        );
    }

    function getLaunchedTokenCount() external view returns (uint256) {
        return launchedTokens.length;
    }

    function getCreatorTokenCount(address creator) external view returns (uint256) {
        return creatorTokens[creator].length;
    }

    function getLaunchedTokens(uint256 offset, uint256 limit) external view returns (address[] memory) {
        return _slice(launchedTokens, offset, limit);
    }

    function getCreatorTokens(
        address creator,
        uint256 offset,
        uint256 limit
    ) external view returns (address[] memory) {
        return _slice(creatorTokens[creator], offset, limit);
    }

    function getTokenInfo(address token) external view returns (TokenInfo memory) {
        return tokenInfo[token];
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    function _validateLaunch(LaunchParams calldata params) private pure {
        uint256 nameLength = bytes(params.name).length;
        uint256 symbolLength = bytes(params.symbol).length;
        if (nameLength == 0) revert EmptyName();
        if (symbolLength == 0) revert EmptySymbol();
        if (nameLength > MAX_NAME_BYTES) revert NameTooLong();
        if (symbolLength > MAX_SYMBOL_BYTES) revert SymbolTooLong();
        if (bytes(params.metadataURI).length > MAX_METADATA_URI_BYTES) revert MetadataURITooLong();
    }

    function _collectLaunchFee(address creator) private {
        uint256 amount = launchFee;
        if (amount == 0) return;
        uint256 balanceBefore = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(creator, address(this), amount);
        if (usdc.balanceOf(address(this)) - balanceBefore != amount) {
            revert UnsupportedTokenBehavior();
        }
        usdc.forceApprove(address(feeVault), amount);
        feeVault.collectFee(address(usdc), creator, LAUNCH_FEE, amount);
        usdc.forceApprove(address(feeVault), 0);
        emit LaunchFeePaid(creator, amount);
    }

    function _requireOwnerOrGuardian() private view {
        if (msg.sender != owner() && msg.sender != emergencyGuardian) revert Unauthorized();
    }

    function _slice(
        address[] storage source,
        uint256 offset,
        uint256 limit
    ) private view returns (address[] memory page) {
        if (limit == 0 || limit > MAX_PAGE_SIZE || offset > source.length) revert InvalidPage();
        uint256 end = offset + limit;
        if (end > source.length) end = source.length;
        page = new address[](end - offset);
        for (uint256 index = offset; index < end; ++index) {
            page[index - offset] = source[index];
        }
    }
}
