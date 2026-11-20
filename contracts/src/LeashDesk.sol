// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IB20} from "base-std/interfaces/IB20.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/// @title LeashDesk
/// @notice Oracle-priced liquidity venue for the testnet deployment. It quotes every listed B20 stock at its
///         Chainlink (mirrored) total-return price plus a fixed spread, and settles by minting and burning the
///         testnet B20 tokens, so liquidity never runs out. On mainnet a vault would route the same trades to
///         DEX or RFQ liquidity for the real Coinbase tokenized stocks; the vault code does not change.
/// @dev    The desk only ever pays out to `msg.sender`, so a vault that trades here cannot be drained by its agent.
contract LeashDesk {
    uint256 internal constant BPS = 10_000;
    uint16 public constant MAX_SPREAD_BPS = 200;

    IB20 public immutable usd;
    uint8 public immutable usdDecimals;

    address public owner;
    uint16 public spreadBps;
    uint32 public maxOracleAge;

    mapping(address token => AggregatorV3Interface) public feedOf;
    address[] internal _tokens;

    event Listed(address indexed token, address indexed feed);
    event Traded(
        address indexed trader, address indexed token, bool buy, uint256 amountIn, uint256 amountOut, uint256 price
    );
    event ParamsSet(uint16 spreadBps, uint32 maxOracleAge);
    event OwnerChanged(address indexed owner);

    error NotOwner();
    error NotListed(address token);
    error BadPrice(address token);
    error StalePrice(address token, uint256 updatedAt);
    error InsufficientOutput(uint256 out, uint256 minOut);
    error ZeroAmount();
    error BadParams();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IB20 usd_, uint16 spreadBps_, uint32 maxOracleAge_) {
        if (spreadBps_ > MAX_SPREAD_BPS || maxOracleAge_ == 0) revert BadParams();
        usd = usd_;
        usdDecimals = usd_.decimals();
        owner = msg.sender;
        spreadBps = spreadBps_;
        maxOracleAge = maxOracleAge_;
        emit OwnerChanged(msg.sender);
        emit ParamsSet(spreadBps_, maxOracleAge_);
    }

    function transferOwnership(address owner_) external onlyOwner {
        owner = owner_;
        emit OwnerChanged(owner_);
    }

    function setParams(uint16 spreadBps_, uint32 maxOracleAge_) external onlyOwner {
        if (spreadBps_ > MAX_SPREAD_BPS || maxOracleAge_ == 0) revert BadParams();
        spreadBps = spreadBps_;
        maxOracleAge = maxOracleAge_;
        emit ParamsSet(spreadBps_, maxOracleAge_);
    }

    function list(address token, AggregatorV3Interface feed) external onlyOwner {
        if (address(feedOf[token]) == address(0)) _tokens.push(token);
        feedOf[token] = feed;
        emit Listed(token, address(feed));
    }

    function tokens() external view returns (address[] memory) {
        return _tokens;
    }

    /// @notice Latest oracle price for one token unit (10**decimals raw units), with the feed's decimals.
    function priceOf(address token) public view returns (uint256 price, uint8 feedDecimals, uint256 updatedAt) {
        AggregatorV3Interface feed = feedOf[token];
        if (address(feed) == address(0)) revert NotListed(token);
        (, int256 answer,, uint256 updated,) = feed.latestRoundData();
        if (answer <= 0) revert BadPrice(token);
        return (uint256(answer), feed.decimals(), updated);
    }

    /// @notice USD value (in `usd` units) of `raw` units of `token` at the oracle price, without spread.
    function valueOf(address token, uint256 raw) public view returns (uint256) {
        (uint256 price, uint8 fd,) = priceOf(token);
        return raw * price * 10 ** usdDecimals / (10 ** (uint256(IB20(token).decimals()) + fd));
    }

    /// @notice Raw `token` units worth `usdAmount` at the oracle price, without spread.
    function unitsFor(address token, uint256 usdAmount) public view returns (uint256) {
        (uint256 price, uint8 fd,) = priceOf(token);
        return usdAmount * 10 ** (uint256(IB20(token).decimals()) + fd) / (price * 10 ** usdDecimals);
    }

    function quote(address token, bool buy, uint256 amountIn) public view returns (uint256) {
        uint256 gross = buy ? unitsFor(token, amountIn) : valueOf(token, amountIn);
        return gross * (BPS - spreadBps) / BPS;
    }

    function buy(address token, uint256 usdIn, uint256 minOut) external returns (uint256 out) {
        if (usdIn == 0) revert ZeroAmount();
        uint256 price = _freshPrice(token);
        out = quote(token, true, usdIn);
        if (out < minOut || out == 0) revert InsufficientOutput(out, minOut);
        usd.transferFrom(msg.sender, address(this), usdIn);
        usd.burn(usdIn);
        IB20(token).mint(msg.sender, out);
        emit Traded(msg.sender, token, true, usdIn, out, price);
    }

    function sell(address token, uint256 rawIn, uint256 minOut) external returns (uint256 out) {
        if (rawIn == 0) revert ZeroAmount();
        uint256 price = _freshPrice(token);
        out = quote(token, false, rawIn);
        if (out < minOut || out == 0) revert InsufficientOutput(out, minOut);
        IB20(token).transferFrom(msg.sender, address(this), rawIn);
        IB20(token).burn(rawIn);
        usd.mint(msg.sender, out);
        emit Traded(msg.sender, token, false, rawIn, out, price);
    }

    function _freshPrice(address token) internal view returns (uint256 price) {
        uint256 updatedAt;
        (price,, updatedAt) = priceOf(token);
        if (block.timestamp > updatedAt + maxOracleAge) revert StalePrice(token, updatedAt);
    }
}
