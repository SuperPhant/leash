// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IB20} from "base-std/interfaces/IB20.sol";
import {IScaledUIAmountConversion} from "base-std/interfaces/IERC8056.sol";
import {LeashDesk} from "./LeashDesk.sol";

/// @title LeashVault
/// @notice A tokenized-stock portfolio that an AI agent may rebalance, but only inside an onchain mandate set by
///         the owner: which stocks, how much of each, how much may be traded per day, how fresh the Chainlink
///         price must be and how far execution may deviate from it. The agent can only swap through the
///         configured desk, so it can never move funds out of the vault. The owner can pause the agent, change
///         the rules and withdraw everything at any time.
contract LeashVault {
    uint256 internal constant BPS = 10_000;
    uint256 public constant MAX_ASSETS = 16;
    uint256 public constant MAX_TRADES = 32;
    uint256 public constant MAX_SLIPPAGE_BPS = 1_000;
    uint256 public constant MAX_URI_LENGTH = 256;

    struct Mandate {
        /// @dev Minimum share of NAV kept in cash after any rebalance that buys.
        uint16 minCashBps;
        /// @dev Maximum traded notional per window, as a share of NAV at the start of the window.
        uint16 maxTurnoverBps;
        /// @dev Length of the turnover window in seconds.
        uint32 turnoverWindow;
        /// @dev Worst accepted execution versus the oracle price.
        uint16 maxSlippageBps;
        /// @dev Oldest accepted oracle update for any traded asset, in seconds.
        uint32 maxOracleAge;
        /// @dev Minimum seconds between two rebalances.
        uint32 cooldown;
        /// @dev Unix time at which the agent's authority ends.
        uint64 expiry;
    }

    struct Trade {
        address token;
        bool buy;
        /// @dev USD units when buying, raw token units when selling.
        uint256 amountIn;
        /// @dev Agent's own floor; the vault additionally enforces the mandate's oracle-based floor.
        uint256 minAmountOut;
    }

    struct Holding {
        address token;
        string symbol;
        uint8 decimals;
        uint16 capBps;
        uint256 raw;
        uint256 ui;
        uint256 price;
        uint8 priceDecimals;
        uint256 updatedAt;
        uint256 value;
        uint256 weightBps;
    }

    LeashDesk public immutable desk;
    IB20 public immutable usd;
    address public immutable factory;

    address public owner;
    address public agent;
    bool public paused;
    Mandate internal _mandate;

    address[] internal _assets;
    mapping(address token => bool) public isAsset;
    mapping(address token => uint16) public capBps;

    uint256 public epoch;
    uint64 public lastRebalance;
    uint64 public windowStart;
    uint256 public windowNav;
    uint256 public windowTurnover;

    bool internal _locked;

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed token, uint256 amount, address indexed to);
    event AgentChanged(address indexed agent);
    event PausedSet(bool paused);
    event CapSet(address indexed token, uint16 capBps);
    event MandateSet(Mandate mandate);
    event TradeExecuted(
        uint256 indexed epoch,
        address indexed token,
        bool buy,
        uint256 amountIn,
        uint256 amountOut,
        uint256 oraclePrice,
        uint256 notional
    );
    event Rebalanced(
        uint256 indexed epoch,
        address indexed agent,
        uint256 navBefore,
        uint256 navAfter,
        uint256 windowTurnover,
        bytes32 rationaleHash,
        string rationaleURI
    );

    error NotOwner();
    error NotAgent();
    error Reentrancy();
    error AgentPaused();
    error MandateExpired(uint256 expiry);
    error CooldownActive(uint256 readyAt);
    error NoTrades();
    error TooManyTrades();
    error TooManyAssets();
    error UriTooLong();
    error ZeroAmount();
    error AssetNotAllowed(address token);
    error BuyNotAllowed(address token);
    error NotListedOnDesk(address token);
    error DuplicateAsset(address token);
    error BadCap(address token, uint256 capBps);
    error BadMandate();
    error StaleOracle(address token, uint256 updatedAt, uint256 maxAge);
    error SlippageExceeded(address token, uint256 amountOut, uint256 minAmountOut);
    error TurnoverExceeded(uint256 turnover, uint256 limit);
    error CashFloorBreached(uint256 cashBps, uint256 minCashBps);
    error WeightCapExceeded(address token, uint256 weightBps, uint256 capBps);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    constructor(
        address owner_,
        address agent_,
        LeashDesk desk_,
        address[] memory assets_,
        uint16[] memory caps_,
        Mandate memory mandate_
    ) {
        if (assets_.length != caps_.length) revert BadMandate();
        if (assets_.length > MAX_ASSETS) revert TooManyAssets();
        desk = desk_;
        usd = desk_.usd();
        factory = msg.sender;
        owner = owner_;
        agent = agent_;
        for (uint256 i; i < assets_.length; ++i) {
            _addAsset(assets_[i], caps_[i]);
        }
        _setMandate(mandate_);
        emit AgentChanged(agent_);
    }

    /*//////////////////////////////////////////////////////////////
                                OWNER
    //////////////////////////////////////////////////////////////*/

    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usd.transferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Owner exit that works even while the agent is paused or the mandate has expired.
    function withdraw(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        IB20(token).transfer(to, amount);
        emit Withdrawn(token, amount, to);
    }

    function withdrawAll(address to) external onlyOwner nonReentrant {
        uint256 cash = usd.balanceOf(address(this));
        if (cash != 0) {
            usd.transfer(to, cash);
            emit Withdrawn(address(usd), cash, to);
        }
        for (uint256 i; i < _assets.length; ++i) {
            uint256 bal = IB20(_assets[i]).balanceOf(address(this));
            if (bal != 0) {
                IB20(_assets[i]).transfer(to, bal);
                emit Withdrawn(_assets[i], bal, to);
            }
        }
    }

    function setAgent(address agent_) external onlyOwner {
        agent = agent_;
        emit AgentChanged(agent_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice Sets the cap of an existing asset, or adds a new desk-listed asset. A cap of 0 means the agent may
    ///         only sell that asset.
    function setCap(address token, uint16 cap) external onlyOwner {
        if (isAsset[token]) {
            if (cap > BPS) revert BadCap(token, cap);
            capBps[token] = cap;
            emit CapSet(token, cap);
        } else {
            _addAsset(token, cap);
        }
    }

    function setMandate(Mandate calldata mandate_) external onlyOwner {
        _setMandate(mandate_);
    }

    /*//////////////////////////////////////////////////////////////
                                AGENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Executes the agent's trades, then proves the resulting portfolio still satisfies the mandate.
    ///         Any violation reverts the whole rebalance.
    /// @param rationaleHash keccak256 of the published rationale document.
    /// @param rationaleURI  Where the rationale document can be fetched.
    function rebalance(Trade[] calldata trades, bytes32 rationaleHash, string calldata rationaleURI)
        external
        nonReentrant
    {
        if (msg.sender != agent) revert NotAgent();
        if (paused) revert AgentPaused();
        Mandate memory m = _mandate;
        if (block.timestamp >= m.expiry) revert MandateExpired(m.expiry);
        if (lastRebalance != 0 && block.timestamp < uint256(lastRebalance) + m.cooldown) {
            revert CooldownActive(uint256(lastRebalance) + m.cooldown);
        }
        if (trades.length == 0) revert NoTrades();
        if (trades.length > MAX_TRADES) revert TooManyTrades();
        if (bytes(rationaleURI).length > MAX_URI_LENGTH) revert UriTooLong();

        uint256 navBefore = nav();
        if (block.timestamp >= uint256(windowStart) + m.turnoverWindow) {
            windowStart = uint64(block.timestamp);
            windowNav = navBefore;
            windowTurnover = 0;
        }

        uint256 nextEpoch = epoch + 1;
        address[] memory bought = new address[](trades.length);
        uint256 boughtCount;
        uint256 turnover = windowTurnover;

        for (uint256 i; i < trades.length; ++i) {
            Trade calldata t = trades[i];
            turnover += _execute(nextEpoch, t, m);
            if (t.buy) bought[boughtCount++] = t.token;
        }

        // Deposits made after the window opened raise the budget; the agent itself can never raise NAV.
        uint256 base = navBefore > windowNav ? navBefore : windowNav;
        uint256 limit = base * m.maxTurnoverBps / BPS;
        if (turnover > limit) revert TurnoverExceeded(turnover, limit);
        windowTurnover = turnover;

        uint256 navAfter = nav();
        if (boughtCount != 0 && navAfter != 0) {
            uint256 cashBps = usd.balanceOf(address(this)) * BPS / navAfter;
            if (cashBps < m.minCashBps) revert CashFloorBreached(cashBps, m.minCashBps);
            for (uint256 i; i < boughtCount; ++i) {
                address token = bought[i];
                uint256 w = desk.valueOf(token, IB20(token).balanceOf(address(this))) * BPS / navAfter;
                if (w > capBps[token]) revert WeightCapExceeded(token, w, capBps[token]);
            }
        }

        epoch = nextEpoch;
        lastRebalance = uint64(block.timestamp);
        emit Rebalanced(nextEpoch, msg.sender, navBefore, navAfter, turnover, rationaleHash, rationaleURI);
    }

    function _execute(uint256 nextEpoch, Trade calldata t, Mandate memory m) internal returns (uint256 notional) {
        if (!isAsset[t.token]) revert AssetNotAllowed(t.token);
        if (t.amountIn == 0) revert ZeroAmount();
        (uint256 price,, uint256 updatedAt) = desk.priceOf(t.token);
        if (block.timestamp > updatedAt + m.maxOracleAge) revert StaleOracle(t.token, updatedAt, m.maxOracleAge);

        uint256 fair;
        IB20 outToken;
        if (t.buy) {
            if (capBps[t.token] == 0) revert BuyNotAllowed(t.token);
            fair = desk.unitsFor(t.token, t.amountIn);
            notional = t.amountIn;
            outToken = IB20(t.token);
        } else {
            fair = desk.valueOf(t.token, t.amountIn);
            notional = fair;
            outToken = usd;
        }
        uint256 minOut = fair * (BPS - m.maxSlippageBps) / BPS;
        if (t.minAmountOut > minOut) minOut = t.minAmountOut;
        uint256 quoted = desk.quote(t.token, t.buy, t.amountIn);
        if (quoted < minOut) revert SlippageExceeded(t.token, quoted, minOut);

        uint256 balBefore = outToken.balanceOf(address(this));
        if (t.buy) {
            usd.approve(address(desk), t.amountIn);
            desk.buy(t.token, t.amountIn, minOut);
        } else {
            IB20(t.token).approve(address(desk), t.amountIn);
            desk.sell(t.token, t.amountIn, minOut);
        }
        uint256 out = outToken.balanceOf(address(this)) - balBefore;
        if (out < minOut) revert SlippageExceeded(t.token, out, minOut);
        emit TradeExecuted(nextEpoch, t.token, t.buy, t.amountIn, out, price, notional);
    }

    /*//////////////////////////////////////////////////////////////
                                VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Net asset value in USD units: cash plus every asset at its oracle (total-return) price.
    /// @dev    Coinbase tokenized-stock feeds already include the B20 multiplier, so raw balances are priced
    ///         directly; the multiplier is only used to display share-equivalent amounts.
    function nav() public view returns (uint256 total) {
        total = usd.balanceOf(address(this));
        for (uint256 i; i < _assets.length; ++i) {
            uint256 bal = IB20(_assets[i]).balanceOf(address(this));
            if (bal != 0) total += desk.valueOf(_assets[i], bal);
        }
    }

    function mandate() external view returns (Mandate memory) {
        return _mandate;
    }

    function assets() external view returns (address[] memory) {
        return _assets;
    }

    /// @notice Turnover still available in the current window (resets once the window has elapsed).
    function turnoverHeadroom() external view returns (uint256 used, uint256 limit, uint256 resetsAt) {
        Mandate memory m = _mandate;
        uint256 current = nav();
        if (block.timestamp >= uint256(windowStart) + m.turnoverWindow) {
            return (0, current * m.maxTurnoverBps / BPS, block.timestamp + m.turnoverWindow);
        }
        uint256 base = current > windowNav ? current : windowNav;
        return (windowTurnover, base * m.maxTurnoverBps / BPS, uint256(windowStart) + m.turnoverWindow);
    }

    /// @notice Everything a dashboard needs in one call.
    function snapshot() external view returns (uint256 cash, uint256 total, Holding[] memory holdings) {
        cash = usd.balanceOf(address(this));
        total = nav();
        holdings = new Holding[](_assets.length);
        for (uint256 i; i < _assets.length; ++i) {
            address token = _assets[i];
            Holding memory h;
            h.token = token;
            h.symbol = IB20(token).symbol();
            h.decimals = IB20(token).decimals();
            h.capBps = capBps[token];
            h.raw = IB20(token).balanceOf(address(this));
            h.ui = _uiAmount(token, h.raw);
            try desk.priceOf(token) returns (uint256 p, uint8 pd, uint256 u) {
                (h.price, h.priceDecimals, h.updatedAt) = (p, pd, u);
                h.value = h.raw == 0 ? 0 : desk.valueOf(token, h.raw);
            } catch {}
            h.weightBps = total == 0 ? 0 : h.value * BPS / total;
            holdings[i] = h;
        }
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _uiAmount(address token, uint256 raw) internal view returns (uint256) {
        try IScaledUIAmountConversion(token).toUIAmount(raw) returns (uint256 ui) {
            return ui;
        } catch {
            return raw;
        }
    }

    function _addAsset(address token, uint16 cap) internal {
        if (_assets.length >= MAX_ASSETS) revert TooManyAssets();
        if (isAsset[token]) revert DuplicateAsset(token);
        if (address(desk.feedOf(token)) == address(0)) revert NotListedOnDesk(token);
        if (cap > BPS) revert BadCap(token, cap);
        _assets.push(token);
        isAsset[token] = true;
        capBps[token] = cap;
        emit CapSet(token, cap);
    }

    function _setMandate(Mandate memory m) internal {
        if (
            m.minCashBps > BPS || m.maxTurnoverBps > 4 * BPS || m.turnoverWindow == 0
                || m.maxSlippageBps > MAX_SLIPPAGE_BPS || m.maxOracleAge == 0 || m.expiry <= block.timestamp
        ) revert BadMandate();
        _mandate = m;
        emit MandateSet(m);
    }
}
