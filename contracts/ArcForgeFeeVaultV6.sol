// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IArcForgeFeeVaultV6} from "./interfaces/IArcForgeFeeVaultV6.sol";

/// @notice Authorized fee accounting and timelock-controlled treasury vault for ArcOrigin V6.
contract ArcForgeFeeVaultV6 is Ownable2Step, ReentrancyGuard, IArcForgeFeeVaultV6 {
    using SafeERC20 for IERC20;

    address public feeRecipient;
    mapping(address collector => bool allowed) public isCollector;
    mapping(address registrar => bool allowed) public isRegistrar;
    mapping(address asset => mapping(bytes32 feeType => uint256 amount)) private feeTotals;

    event CollectorUpdated(address indexed collector, bool allowed);
    event RegistrarUpdated(address indexed registrar, bool allowed);
    event FeeReceived(address indexed asset, address indexed payer, bytes32 indexed feeType, uint256 amount);
    event FeeWithdrawn(address indexed asset, address indexed recipient, uint256 amount);
    event FeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);

    error ZeroAddress();
    error ZeroAmount();
    error UnauthorizedCollector();
    error UnauthorizedRegistrar();
    error UnsupportedAssetBehavior();
    error RenounceDisabled();

    constructor(address owner_, address feeRecipient_) Ownable(owner_) {
        if (owner_ == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        feeRecipient = feeRecipient_;
    }

    /// @notice Pulls and records a real fee only from a governance-authorized collector.
    function collectFee(
        address asset,
        address payer,
        bytes32 feeType,
        uint256 amount
    ) external override nonReentrant {
        if (!isCollector[msg.sender]) revert UnauthorizedCollector();
        if (asset == address(0) || payer == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        IERC20 assetToken = IERC20(asset);
        uint256 balanceBefore = assetToken.balanceOf(address(this));
        assetToken.safeTransferFrom(msg.sender, address(this), amount);
        if (assetToken.balanceOf(address(this)) - balanceBefore != amount) {
            revert UnsupportedAssetBehavior();
        }

        feeTotals[asset][feeType] += amount;
        emit FeeReceived(asset, payer, feeType, amount);
    }

    /// @notice Lets an authorized, immutable Factory register only the curves it deploys.
    function setCollector(address collector, bool allowed) external override {
        if (msg.sender != owner() && !isRegistrar[msg.sender]) revert UnauthorizedRegistrar();
        if (collector == address(0)) revert ZeroAddress();
        isCollector[collector] = allowed;
        emit CollectorUpdated(collector, allowed);
    }

    function setRegistrar(address registrar, bool allowed) external onlyOwner {
        if (registrar == address(0)) revert ZeroAddress();
        isRegistrar[registrar] = allowed;
        emit RegistrarUpdated(registrar, allowed);
    }

    /// @notice Only governance can execute withdrawals; the recipient cannot bypass the timelock.
    function withdraw(address asset, uint256 amount) external onlyOwner nonReentrant {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(asset).safeTransfer(feeRecipient, amount);
        emit FeeWithdrawn(asset, feeRecipient, amount);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        address previous = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(previous, newRecipient);
    }

    function getFeeTotal(address asset, bytes32 feeType) external view returns (uint256) {
        return feeTotals[asset][feeType];
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }
}
