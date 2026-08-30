// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ArcForgeTokenV7} from "./ArcForgeTokenV7.sol";
import {ArcForgeFeeVaultV6} from "./ArcForgeFeeVaultV6.sol";
import {ArcForgeCreatorRegistryV6} from "./ArcForgeCreatorRegistryV6.sol";
import {IUniswapV3FactoryMinimal, IUniswapV3PoolMinimal, INonfungiblePositionManagerMinimal} from "./interfaces/IUniswapV3Minimal.sol";
import {ArcOriginUniswapV3Math} from "./uniswap/ArcOriginUniswapV3Math.sol";
import {ArcOriginUniswapV3LaunchLockerV7} from "./uniswap/ArcOriginUniswapV3LaunchLockerV7.sol";

/// @notice ArcOrigin V7 direct-to-Uniswap-V3 launch factory.
/// @dev Every launch creates or initializes a canonical pool and permanently locks a
///      single-sided LP NFT in the same transaction. There is no later migration path.
contract ArcForgeFactoryV7 is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;
    uint256 public constant START_MARKET_CAP = 5_000 * 1e6;
    uint256 public constant CROSS_MARKET_CAP = 50_000 * 1e6;
    uint256 public constant MAX_NAME_BYTES = 64;
    uint256 public constant MAX_SYMBOL_BYTES = 10;
    uint256 public constant MAX_METADATA_URI_BYTES = 512;
    uint256 public constant MAX_LAUNCH_FEE = 100 * 1e6;
    uint256 public constant MAX_PAGE_SIZE = 100;
    uint16 public constant CREATOR_FEE_SHARE_BPS = 7_000;
    uint24 public constant POOL_FEE = 10_000;
    bytes32 public constant LAUNCH_FEE = keccak256("LAUNCH_FEE");

    struct LaunchParams {
        string name;
        string symbol;
        string metadataURI;
    }

    struct TokenInfo {
        address token;
        address pool;
        address creator;
        uint256 positionId;
        uint64 launchedAt;
        bool tokenIsToken0;
        bool crossed;
        string metadataURI;
    }

    struct LiquidityResult {
        uint256 positionId;
        uint128 liquidity;
        uint256 lockedSupply;
        int24 tickLower;
        int24 tickUpper;
    }

    IERC20 public immutable usdc;
    ArcForgeFeeVaultV6 public immutable feeVault;
    ArcForgeCreatorRegistryV6 public immutable creatorRegistry;
    IUniswapV3FactoryMinimal public immutable uniswapV3Factory;
    INonfungiblePositionManagerMinimal public immutable positionManager;
    ArcOriginUniswapV3LaunchLockerV7 public immutable liquidityLocker;
    uint256 public launchFee;
    uint256 public launchNonce;
    address public emergencyGuardian;

    address[] private launchedTokens;
    mapping(address token => TokenInfo info) private tokenInfo;
    mapping(address creator => address[] tokens) private creatorTokens;

    event TokenLaunched(
        address indexed token,
        address indexed pool,
        address indexed creator,
        string name,
        string symbol,
        uint256 positionId
    );
    event PermanentLiquidityLocked(
        address indexed token,
        address indexed pool,
        uint256 indexed positionId,
        uint256 lockedSupply,
        int24 tickLower,
        int24 tickUpper
    );
    event TokenCrossed(address indexed token, address indexed pool, uint256 marketCap);
    event LaunchFeePaid(address indexed creator, uint256 amount);
    event LaunchFeeUpdated(uint256 previousFee, uint256 newFee);
    event EmergencyGuardianUpdated(address indexed previousGuardian, address indexed newGuardian);

    error EmptyName();
    error EmptySymbol();
    error NameTooLong();
    error SymbolTooLong();
    error MetadataURITooLong();
    error InvalidConfiguration();
    error InvalidPage();
    error InvalidToken();
    error Unauthorized();
    error UnsupportedTokenBehavior();
    error ExistingInitializedPool();
    error InvalidPool();
    error InvalidLiquidityPosition();
    error RenounceDisabled();

    constructor(
        address owner_,
        address emergencyGuardian_,
        address usdc_,
        address feeVault_,
        address creatorRegistry_,
        address uniswapV3Factory_,
        address positionManager_,
        uint256 launchFee_
    ) Ownable(owner_) {
        if (
            owner_ == address(0) ||
            emergencyGuardian_ == address(0) ||
            usdc_ == address(0) ||
            feeVault_ == address(0) ||
            creatorRegistry_ == address(0) ||
            uniswapV3Factory_ == address(0) ||
            positionManager_ == address(0)
        ) revert InvalidConfiguration();
        if (
            usdc_.code.length == 0 ||
            feeVault_.code.length == 0 ||
            creatorRegistry_.code.length == 0 ||
            uniswapV3Factory_.code.length == 0 ||
            positionManager_.code.length == 0 ||
            IERC20Metadata(usdc_).decimals() != 6 ||
            launchFee_ > MAX_LAUNCH_FEE ||
            INonfungiblePositionManagerMinimal(positionManager_).factory() != uniswapV3Factory_ ||
            IUniswapV3FactoryMinimal(uniswapV3Factory_).feeAmountTickSpacing(POOL_FEE) <= 0
        ) revert InvalidConfiguration();

        usdc = IERC20(usdc_);
        feeVault = ArcForgeFeeVaultV6(feeVault_);
        creatorRegistry = ArcForgeCreatorRegistryV6(creatorRegistry_);
        uniswapV3Factory = IUniswapV3FactoryMinimal(uniswapV3Factory_);
        positionManager = INonfungiblePositionManagerMinimal(positionManager_);
        emergencyGuardian = emergencyGuardian_;
        launchFee = launchFee_;
        liquidityLocker = new ArcOriginUniswapV3LaunchLockerV7(
            address(this),
            positionManager_,
            feeVault_
        );
        _pause();
    }

    function launchToken(
        LaunchParams calldata params
    ) external whenNotPaused nonReentrant returns (address token, address pool) {
        _validateLaunch(params);
        _collectLaunchFee(msg.sender);

        bytes32 tokenSalt = keccak256(
            abi.encode(blockhash(block.number - 1), msg.sender, launchNonce++)
        );
        ArcForgeTokenV7 launchedToken = new ArcForgeTokenV7{salt: tokenSalt}(
            params.name,
            params.symbol,
            TOTAL_SUPPLY,
            msg.sender,
            params.metadataURI
        );
        token = address(launchedToken);

        bool tokenIsToken0 = token < address(usdc);
        (address token0, address token1, uint256 amount0ForPrice, uint256 amount1ForPrice) =
            ArcOriginUniswapV3Math.sortTokens(
                token,
                address(usdc),
                TOTAL_SUPPLY,
                START_MARKET_CAP
            );
        uint160 initialSqrtPriceX96 = ArcOriginUniswapV3Math.encodeSqrtRatioX96(
            amount0ForPrice,
            amount1ForPrice
        );

        pool = _createOrInitializePool(token0, token1, initialSqrtPriceX96);
        LiquidityResult memory result = _seedPermanentLiquidity(
            token,
            pool,
            token0,
            token1,
            tokenIsToken0
        );
        uint256 dust = TOTAL_SUPPLY - result.lockedSupply;
        launchedToken.burnFactoryDust(dust);
        if (
            launchedToken.totalSupply() != result.lockedSupply ||
            launchedToken.balanceOf(address(this)) != 0
        ) {
            revert InvalidLiquidityPosition();
        }

        liquidityLocker.registerPosition(
            ArcOriginUniswapV3LaunchLockerV7.RegisterParams({
                positionId: result.positionId,
                pool: pool,
                token0: token0,
                token1: token1,
                launchToken: token,
                creatorFeeRecipient: msg.sender,
                creatorFeeShareBps: CREATOR_FEE_SHARE_BPS,
                fee: POOL_FEE,
                tickLower: result.tickLower,
                tickUpper: result.tickUpper,
                liquidity: result.liquidity,
                launchTokenPrincipal: result.lockedSupply
            })
        );

        _recordLaunch(params, token, pool, tokenIsToken0, result);
    }

    /// @notice Permanently records the milestone once the live pool reaches $50k market cap.
    /// @dev Anyone may call this; direct Uniswap swaps cannot call the factory themselves.
    function markCrossed(address token) external returns (bool newlyCrossed) {
        TokenInfo storage info = tokenInfo[token];
        if (info.pool == address(0)) revert InvalidToken();
        if (info.crossed) return false;
        uint256 marketCap = currentMarketCap(token);
        if (marketCap < CROSS_MARKET_CAP) return false;
        info.crossed = true;
        emit TokenCrossed(token, info.pool, marketCap);
        return true;
    }

    function currentMarketCap(address token) public view returns (uint256) {
        TokenInfo storage info = tokenInfo[token];
        if (info.pool == address(0)) revert InvalidToken();
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3PoolMinimal(info.pool).slot0();
        return ArcOriginUniswapV3Math.marketCapFromSqrtPriceX96(
            sqrtPriceX96,
            IERC20(token).totalSupply(),
            info.tokenIsToken0
        );
    }

    function isCrossed(address token) external view returns (bool) {
        TokenInfo storage info = tokenInfo[token];
        if (info.pool == address(0)) return false;
        return info.crossed || currentMarketCap(token) >= CROSS_MARKET_CAP;
    }

    function crossProgressBps(address token) external view returns (uint256) {
        uint256 marketCap = currentMarketCap(token);
        if (marketCap >= CROSS_MARKET_CAP) return 10_000;
        return marketCap * 10_000 / CROSS_MARKET_CAP;
    }

    function setLaunchFee(uint256 newFee) external onlyOwner {
        if (newFee > MAX_LAUNCH_FEE) revert InvalidConfiguration();
        uint256 previous = launchFee;
        launchFee = newFee;
        emit LaunchFeeUpdated(previous, newFee);
    }

    function pauseLaunches() external {
        if (msg.sender != owner() && msg.sender != emergencyGuardian) revert Unauthorized();
        _pause();
    }

    function unpauseLaunches() external onlyOwner {
        _unpause();
    }

    function setEmergencyGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert InvalidConfiguration();
        address previous = emergencyGuardian;
        emergencyGuardian = newGuardian;
        emit EmergencyGuardianUpdated(previous, newGuardian);
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

    function _createOrInitializePool(
        address token0,
        address token1,
        uint160 initialSqrtPriceX96
    ) private returns (address pool) {
        address existingPool = uniswapV3Factory.getPool(token0, token1, POOL_FEE);
        if (existingPool != address(0)) {
            (uint160 existingPrice, , , , , , ) = IUniswapV3PoolMinimal(existingPool).slot0();
            if (existingPrice != 0) revert ExistingInitializedPool();
        }

        pool = positionManager.createAndInitializePoolIfNecessary(
            token0,
            token1,
            POOL_FEE,
            initialSqrtPriceX96
        );
        if (
            pool == address(0) ||
            pool != uniswapV3Factory.getPool(token0, token1, POOL_FEE) ||
            IUniswapV3PoolMinimal(pool).factory() != address(uniswapV3Factory) ||
            IUniswapV3PoolMinimal(pool).token0() != token0 ||
            IUniswapV3PoolMinimal(pool).token1() != token1 ||
            IUniswapV3PoolMinimal(pool).fee() != POOL_FEE
        ) revert InvalidPool();
        (uint160 actualPrice, , , , , , ) = IUniswapV3PoolMinimal(pool).slot0();
        if (actualPrice != initialSqrtPriceX96) revert InvalidPool();
    }

    function _seedPermanentLiquidity(
        address token,
        address pool,
        address token0,
        address token1,
        bool tokenIsToken0
    ) private returns (LiquidityResult memory result) {
        (, int24 currentTick, , , , , ) = IUniswapV3PoolMinimal(pool).slot0();
        (result.tickLower, result.tickUpper) = ArcOriginUniswapV3Math.singleSidedTicks(
            currentTick,
            uniswapV3Factory.feeAmountTickSpacing(POOL_FEE),
            tokenIsToken0
        );

        IERC20(token).forceApprove(address(positionManager), TOTAL_SUPPLY);
        uint256 amount0Used;
        uint256 amount1Used;
        (result.positionId, result.liquidity, amount0Used, amount1Used) =
            positionManager.mint(
                INonfungiblePositionManagerMinimal.MintParams({
                    token0: token0,
                    token1: token1,
                    fee: POOL_FEE,
                    tickLower: result.tickLower,
                    tickUpper: result.tickUpper,
                    amount0Desired: tokenIsToken0 ? TOTAL_SUPPLY : 0,
                    amount1Desired: tokenIsToken0 ? 0 : TOTAL_SUPPLY,
                    amount0Min: 0,
                    amount1Min: 0,
                    recipient: address(liquidityLocker),
                    deadline: block.timestamp
                })
            );
        IERC20(token).forceApprove(address(positionManager), 0);

        result.lockedSupply = tokenIsToken0 ? amount0Used : amount1Used;
        uint256 quoteUsed = tokenIsToken0 ? amount1Used : amount0Used;
        if (result.liquidity == 0 || result.lockedSupply == 0 || quoteUsed != 0) {
            revert InvalidLiquidityPosition();
        }
    }

    function _recordLaunch(
        LaunchParams calldata params,
        address token,
        address pool,
        bool tokenIsToken0,
        LiquidityResult memory result
    ) private {
        launchedTokens.push(token);
        creatorTokens[msg.sender].push(token);
        tokenInfo[token] = TokenInfo({
            token: token,
            pool: pool,
            creator: msg.sender,
            positionId: result.positionId,
            launchedAt: uint64(block.timestamp),
            tokenIsToken0: tokenIsToken0,
            crossed: false,
            metadataURI: params.metadataURI
        });
        creatorRegistry.recordLaunch(msg.sender, token);

        emit PermanentLiquidityLocked(
            token,
            pool,
            result.positionId,
            result.lockedSupply,
            result.tickLower,
            result.tickUpper
        );
        emit TokenLaunched(
            token,
            pool,
            msg.sender,
            params.name,
            params.symbol,
            result.positionId
        );
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
