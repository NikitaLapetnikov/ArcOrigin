// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {INonfungiblePositionManagerMinimal} from "../interfaces/IUniswapV3Minimal.sol";
import {MockUniswapV3Factory} from "./MockUniswapV3Factory.sol";
import {MockUniswapV3Pool} from "./MockUniswapV3Pool.sol";

contract MockUniswapV3PositionManager is INonfungiblePositionManagerMinimal {
    using SafeERC20 for IERC20;

    struct Position {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    address public immutable override factory;
    uint256 private _nextTokenId = 1;
    mapping(uint256 tokenId => Position position) private _positions;
    mapping(uint256 tokenId => address owner) private _owners;

    error Expired();
    error InvalidPosition();
    error InsufficientAmount();
    error AmountOverflow();
    error UnsafeRecipient();

    constructor(address factory_) {
        factory = factory_;
    }

    function createAndInitializePoolIfNecessary(
        address token0,
        address token1,
        uint24 fee,
        uint160 sqrtPriceX96
    ) external payable returns (address pool) {
        MockUniswapV3Factory targetFactory = MockUniswapV3Factory(factory);
        pool = targetFactory.getPool(token0, token1, fee);
        if (pool == address(0)) {
            pool = targetFactory.createPool(token0, token1, fee);
        }
        (uint160 currentPrice, , , , , , ) = MockUniswapV3Pool(pool).slot0();
        if (currentPrice == 0) MockUniswapV3Pool(pool).initialize(sqrtPriceX96);
    }

    function mint(
        MintParams calldata params
    )
        external
        payable
        returns (
            uint256 tokenId,
            uint128 liquidity,
            uint256 amount0,
            uint256 amount1
        )
    {
        if (params.deadline < block.timestamp) revert Expired();
        address pool = MockUniswapV3Factory(factory).getPool(
            params.token0,
            params.token1,
            params.fee
        );
        if (pool == address(0)) revert InvalidPosition();
        amount0 = params.amount0Desired;
        amount1 = params.amount1Desired;
        if (amount0 < params.amount0Min || amount1 < params.amount1Min) {
            revert InsufficientAmount();
        }
        uint256 rawLiquidity = amount0 == 0
            ? amount1
            : amount1 == 0
                ? amount0
                : amount0 < amount1 ? amount0 : amount1;
        if (rawLiquidity == 0 || rawLiquidity > type(uint128).max) {
            revert AmountOverflow();
        }
        liquidity = uint128(rawLiquidity);

        if (amount0 != 0) IERC20(params.token0).safeTransferFrom(msg.sender, pool, amount0);
        if (amount1 != 0) IERC20(params.token1).safeTransferFrom(msg.sender, pool, amount1);
        MockUniswapV3Pool(pool).addLiquidity(liquidity);

        tokenId = _nextTokenId++;
        _positions[tokenId] = Position({
            token0: params.token0,
            token1: params.token1,
            fee: params.fee,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: liquidity,
            tokensOwed0: 0,
            tokensOwed1: 0
        });
        _safeMint(params.recipient, tokenId);
    }

    function collect(
        CollectParams calldata params
    ) external payable returns (uint256 amount0, uint256 amount1) {
        if (ownerOf(params.tokenId) != msg.sender) revert InvalidPosition();
        Position storage position = _positions[params.tokenId];
        amount0 =
            position.tokensOwed0 < params.amount0Max
                ? position.tokensOwed0
                : params.amount0Max;
        amount1 =
            position.tokensOwed1 < params.amount1Max
                ? position.tokensOwed1
                : params.amount1Max;
        position.tokensOwed0 -= uint128(amount0);
        position.tokensOwed1 -= uint128(amount1);
        if (amount0 != 0) IERC20(position.token0).safeTransfer(params.recipient, amount0);
        if (amount1 != 0) IERC20(position.token1).safeTransfer(params.recipient, amount1);
    }

    function seedFees(
        uint256 tokenId,
        uint128 amount0,
        uint128 amount1
    ) external {
        ownerOf(tokenId);
        Position storage position = _positions[tokenId];
        if (amount0 != 0) {
            IERC20(position.token0).safeTransferFrom(msg.sender, address(this), amount0);
            position.tokensOwed0 += amount0;
        }
        if (amount1 != 0) {
            IERC20(position.token1).safeTransferFrom(msg.sender, address(this), amount1);
            position.tokensOwed1 += amount1;
        }
    }

    function ownerOf(
        uint256 tokenId
    )
        public
        view
        override
        returns (address owner)
    {
        owner = _owners[tokenId];
        if (owner == address(0)) revert InvalidPosition();
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        if (msg.sender != from || ownerOf(tokenId) != from || to == address(0)) {
            revert InvalidPosition();
        }
        _owners[tokenId] = to;
    }

    function positions(
        uint256 tokenId
    )
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        ownerOf(tokenId);
        Position storage position = _positions[tokenId];
        return (
            0,
            address(0),
            position.token0,
            position.token1,
            position.fee,
            position.tickLower,
            position.tickUpper,
            position.liquidity,
            0,
            0,
            position.tokensOwed0,
            position.tokensOwed1
        );
    }

    function _safeMint(address recipient, uint256 tokenId) private {
        if (recipient == address(0)) revert UnsafeRecipient();
        _owners[tokenId] = recipient;
        if (recipient.code.length != 0) {
            bytes4 result = IERC721Receiver(recipient).onERC721Received(
                msg.sender,
                address(0),
                tokenId,
                ""
            );
            if (result != IERC721Receiver.onERC721Received.selector) {
                revert UnsafeRecipient();
            }
        }
    }
}
