// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IArcOriginBuybackCurve} from "./interfaces/IArcOriginBuybackCurve.sol";

/// @notice Routes 80% of allocated protocol revenue into bounded protocol-token buybacks
///         and sends the remaining 20% to the operations Safe.
/// @dev Bought tokens are deliberately sent to the canonical burn address because the
///      fixed-supply launch token has no privileged burn or supply-control hook.
contract ArcOriginBuybackController is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint16 public constant BUYBACK_SHARE_BPS = 8_000;
    uint16 public constant MAX_SLIPPAGE_BPS = 500;
    uint16 public constant MAX_CHUNK_VIRTUAL_RESERVE_BPS = 100;
    uint64 public constant MIN_EXECUTION_INTERVAL = 5 minutes;
    uint64 public constant MAX_EXECUTION_INTERVAL = 30 days;
    uint64 public constant MAX_DEADLINE_WINDOW = 15 minutes;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable usdc;
    IERC20 public immutable protocolToken;
    IArcOriginBuybackCurve public immutable curve;
    uint256 public immutable maximumPermittedChunkUsdc;

    address public operationsRecipient;
    address public emergencyGuardian;
    mapping(address executor => bool allowed) public isExecutor;

    uint256 public pendingBuybackUsdc;
    uint256 public totalRevenueAllocated;
    uint256 public totalOperationsTransferred;
    uint256 public totalBuybackUsdcSpent;
    uint256 public totalTokensBurned;

    uint256 public maxChunkUsdc;
    uint64 public executionInterval;
    uint64 public lastExecutionAt;
    uint16 public maxSlippageBps;

    event RevenueAllocated(uint256 revenue, uint256 buybackAmount, uint256 operationsAmount);
    event BuybackExecuted(
        address indexed executor,
        uint256 usdcSpent,
        uint256 tokensBurned,
        uint256 pendingBuybackUsdc
    );
    event ProtocolTokensBurned(address indexed caller, uint256 amount);
    event ExecutorUpdated(address indexed executor, bool allowed);
    event ExecutionConfigUpdated(uint256 maxChunkUsdc, uint64 executionInterval, uint16 maxSlippageBps);
    event OperationsRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);
    event EmergencyGuardianUpdated(address indexed previousGuardian, address indexed newGuardian);
    event NonCoreTokenRecovered(address indexed asset, address indexed recipient, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error InvalidConfiguration();
    error Unauthorized();
    error NoRevenue();
    error InsufficientPendingBuyback();
    error ChunkLimitExceeded();
    error CooldownActive(uint256 nextExecutionAt);
    error InvalidDeadline();
    error InvalidMinimumOutput();
    error QuoteUnavailable();
    error TradingMigrated();
    error UnsupportedAssetBehavior();
    error CoreAssetRecoveryDisabled();
    error AccountingInvariantBroken();
    error RenounceDisabled();

    constructor(
        address owner_,
        address emergencyGuardian_,
        address operationsRecipient_,
        address executor_,
        address usdc_,
        address protocolToken_,
        address curve_,
        uint256 maxChunkUsdc_,
        uint64 executionInterval_,
        uint16 maxSlippageBps_
    ) Ownable(owner_) {
        if (
            owner_ == address(0) ||
            emergencyGuardian_ == address(0) ||
            operationsRecipient_ == address(0) ||
            executor_ == address(0) ||
            usdc_ == address(0) ||
            protocolToken_ == address(0) ||
            curve_ == address(0)
        ) revert ZeroAddress();
        if (
            operationsRecipient_ == address(this) ||
            usdc_.code.length == 0 ||
            protocolToken_.code.length == 0 ||
            curve_.code.length == 0
        ) revert InvalidConfiguration();

        IArcOriginBuybackCurve configuredCurve = IArcOriginBuybackCurve(curve_);
        if (
            configuredCurve.token() != protocolToken_ ||
            configuredCurve.usdc() != usdc_
        ) revert InvalidConfiguration();

        uint256 permittedChunk = Math.mulDiv(
            configuredCurve.virtualUsdcReserve(),
            MAX_CHUNK_VIRTUAL_RESERVE_BPS,
            BPS
        );
        if (permittedChunk == 0) revert InvalidConfiguration();

        usdc = IERC20(usdc_);
        protocolToken = IERC20(protocolToken_);
        curve = configuredCurve;
        maximumPermittedChunkUsdc = permittedChunk;
        operationsRecipient = operationsRecipient_;
        emergencyGuardian = emergencyGuardian_;
        isExecutor[executor_] = true;
        emit ExecutorUpdated(executor_, true);

        _setExecutionConfig(maxChunkUsdc_, executionInterval_, maxSlippageBps_);
    }

    /// @notice Accounts for every unallocated USDC unit currently held by this
    ///         contract. Anyone may call it; the fixed 80/20 split is immutable.
    function allocateRevenue() external whenNotPaused nonReentrant returns (
        uint256 buybackAmount,
        uint256 operationsAmount
    ) {
        uint256 balance = usdc.balanceOf(address(this));
        uint256 pending = pendingBuybackUsdc;
        if (balance < pending) revert AccountingInvariantBroken();

        uint256 revenue = balance - pending;
        if (revenue == 0) revert NoRevenue();

        buybackAmount = Math.mulDiv(revenue, BUYBACK_SHARE_BPS, BPS);
        operationsAmount = revenue - buybackAmount;
        if (buybackAmount == 0) revert ZeroAmount();

        pendingBuybackUsdc = pending + buybackAmount;
        totalRevenueAllocated += revenue;
        totalOperationsTransferred += operationsAmount;

        if (operationsAmount != 0) {
            address recipient = operationsRecipient;
            uint256 recipientBalanceBefore = usdc.balanceOf(recipient);
            usdc.safeTransfer(recipient, operationsAmount);
            if (usdc.balanceOf(recipient) - recipientBalanceBefore != operationsAmount) {
                revert UnsupportedAssetBehavior();
            }
        }
        emit RevenueAllocated(revenue, buybackAmount, operationsAmount);
    }

    /// @notice Executes one TWAP slice and permanently sends the received protocol token
    ///         to the burn address. The authorized executor cannot redirect it.
    function executeBuyback(
        uint256 usdcAmount,
        uint256 minTokensOut,
        uint256 deadline
    ) external whenNotPaused nonReentrant returns (uint256 tokensBurned) {
        if (msg.sender != owner() && !isExecutor[msg.sender]) revert Unauthorized();
        if (curve.isMigrated()) revert TradingMigrated();
        if (usdcAmount == 0) revert ZeroAmount();
        if (usdcAmount > pendingBuybackUsdc) revert InsufficientPendingBuyback();
        if (usdcAmount > maxChunkUsdc) revert ChunkLimitExceeded();
        if (deadline < block.timestamp || deadline > block.timestamp + MAX_DEADLINE_WINDOW) {
            revert InvalidDeadline();
        }

        uint64 previousExecutionAt = lastExecutionAt;
        uint256 nextExecutionAt = uint256(previousExecutionAt) + executionInterval;
        if (previousExecutionAt != 0 && block.timestamp < nextExecutionAt) {
            revert CooldownActive(nextExecutionAt);
        }

        (uint256 quotedTokens,) = curve.quoteBuy(usdcAmount);
        if (quotedTokens == 0) revert QuoteUnavailable();
        uint256 minimumAllowed = Math.mulDiv(
            quotedTokens,
            BPS - maxSlippageBps,
            BPS
        );
        if (minTokensOut < minimumAllowed || minTokensOut > quotedTokens) {
            revert InvalidMinimumOutput();
        }

        uint256 usdcBalanceBefore = usdc.balanceOf(address(this));
        uint256 tokenBalanceBefore = protocolToken.balanceOf(address(this));
        pendingBuybackUsdc -= usdcAmount;
        lastExecutionAt = uint64(block.timestamp);

        usdc.forceApprove(address(curve), usdcAmount);
        uint256 reportedTokens = curve.buy(usdcAmount, minTokensOut, deadline);
        usdc.forceApprove(address(curve), 0);

        if (
            usdcBalanceBefore - usdc.balanceOf(address(this)) != usdcAmount ||
            protocolToken.balanceOf(address(this)) - tokenBalanceBefore != reportedTokens ||
            reportedTokens == 0
        ) revert UnsupportedAssetBehavior();

        uint256 burnBalanceBefore = protocolToken.balanceOf(BURN_ADDRESS);
        protocolToken.safeTransfer(BURN_ADDRESS, reportedTokens);
        if (protocolToken.balanceOf(BURN_ADDRESS) - burnBalanceBefore != reportedTokens) {
            revert UnsupportedAssetBehavior();
        }

        tokensBurned = reportedTokens;
        totalBuybackUsdcSpent += usdcAmount;
        totalTokensBurned += tokensBurned;
        emit BuybackExecuted(msg.sender, usdcAmount, tokensBurned, pendingBuybackUsdc);
    }

    /// @notice Burns protocol tokens accidentally sent directly to this contract.
    function burnHeldProtocolTokens() external whenNotPaused nonReentrant returns (uint256 amount) {
        amount = protocolToken.balanceOf(address(this));
        if (amount == 0) revert ZeroAmount();
        uint256 burnBalanceBefore = protocolToken.balanceOf(BURN_ADDRESS);
        protocolToken.safeTransfer(BURN_ADDRESS, amount);
        if (protocolToken.balanceOf(BURN_ADDRESS) - burnBalanceBefore != amount) {
            revert UnsupportedAssetBehavior();
        }
        totalTokensBurned += amount;
        emit ProtocolTokensBurned(msg.sender, amount);
    }

    function setExecutor(address executor, bool allowed) external onlyOwner {
        if (executor == address(0)) revert ZeroAddress();
        isExecutor[executor] = allowed;
        emit ExecutorUpdated(executor, allowed);
    }

    function setExecutionConfig(
        uint256 maxChunkUsdc_,
        uint64 executionInterval_,
        uint16 maxSlippageBps_
    ) external onlyOwner {
        _setExecutionConfig(maxChunkUsdc_, executionInterval_, maxSlippageBps_);
    }

    function setOperationsRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        if (newRecipient == address(this)) revert InvalidConfiguration();
        address previous = operationsRecipient;
        operationsRecipient = newRecipient;
        emit OperationsRecipientUpdated(previous, newRecipient);
    }

    function setEmergencyGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert ZeroAddress();
        address previous = emergencyGuardian;
        emergencyGuardian = newGuardian;
        emit EmergencyGuardianUpdated(previous, newGuardian);
    }

    function pause() external {
        if (msg.sender != owner() && msg.sender != emergencyGuardian) revert Unauthorized();
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Only unrelated tokens can be recovered. The protocol token is always burned and
    ///         USDC is always routed through the immutable revenue split.
    function recoverNonCoreToken(
        address asset,
        address recipient,
        uint256 amount
    ) external onlyOwner nonReentrant {
        if (asset == address(0) || recipient == address(0)) revert ZeroAddress();
        if (asset == address(usdc) || asset == address(protocolToken)) {
            revert CoreAssetRecoveryDisabled();
        }
        if (amount == 0) revert ZeroAmount();
        IERC20(asset).safeTransfer(recipient, amount);
        emit NonCoreTokenRecovered(asset, recipient, amount);
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    function _setExecutionConfig(
        uint256 maxChunkUsdc_,
        uint64 executionInterval_,
        uint16 maxSlippageBps_
    ) private {
        if (
            maxChunkUsdc_ == 0 ||
            maxChunkUsdc_ > maximumPermittedChunkUsdc ||
            executionInterval_ < MIN_EXECUTION_INTERVAL ||
            executionInterval_ > MAX_EXECUTION_INTERVAL ||
            maxSlippageBps_ > MAX_SLIPPAGE_BPS
        ) revert InvalidConfiguration();

        maxChunkUsdc = maxChunkUsdc_;
        executionInterval = executionInterval_;
        maxSlippageBps = maxSlippageBps_;
        emit ExecutionConfigUpdated(maxChunkUsdc_, executionInterval_, maxSlippageBps_);
    }
}
