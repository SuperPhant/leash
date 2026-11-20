// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {IB20Asset} from "base-std/interfaces/IB20Asset.sol";
import {IB20Factory} from "base-std/interfaces/IB20Factory.sol";
import {StdPrecompiles} from "base-std/StdPrecompiles.sol";
import {B20FactoryLib} from "base-std/lib/B20FactoryLib.sol";
import {B20Constants} from "base-std/lib/B20Constants.sol";

import {MirrorFeedHub, MirrorFeed} from "../src/MirrorFeedHub.sol";
import {LeashDesk} from "../src/LeashDesk.sol";
import {LeashVault} from "../src/LeashVault.sol";
import {LeashFactory} from "../src/LeashFactory.sol";
import {UsdFaucet} from "../src/UsdFaucet.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";

contract LeashTest is Test {
    address agent = makeAddr("agent");
    uint256 alicePk = 0xA11CE;
    address alice = vm.addr(alicePk);

    MirrorFeedHub hub;
    LeashDesk desk;
    LeashFactory factory;
    UsdFaucet faucet;
    IB20 usd;
    IB20 aapl;
    IB20 nvda;
    IB20 tsla;
    IB20 meta;
    LeashVault vault;

    uint256 constant START = 1_800_000_000;

    function setUp() public {
        vm.warp(START);
        // Live Base networks have these features on; a fresh local EVM starts with them off.
        _activateIfNeeded("base.b20_asset");
        _activateIfNeeded("base.b20_stablecoin");
        _activateIfNeeded("base.policy_registry");
        hub = new MirrorFeedHub(agent);

        usd = IB20(
            StdPrecompiles.B20_FACTORY.createB20(
                IB20Factory.B20Variant.STABLECOIN,
                keccak256("tusd"),
                B20FactoryLib.encodeStablecoinCreateParams("Leash Test USD", "tUSD", address(this), "USD"),
                new bytes[](0)
            )
        );
        desk = new LeashDesk(usd, 10, 4 days);
        faucet = new UsdFaucet(usd, 10_000e6, 1 days);
        usd.grantRole(B20Constants.MINT_ROLE, address(desk));
        usd.grantRole(B20Constants.BURN_ROLE, address(desk));
        usd.grantRole(B20Constants.MINT_ROLE, address(faucet));

        aapl = _stock("AAPL", 200e8);
        nvda = _stock("NVDA", 150e8);
        tsla = _stock("TSLA", 350e8);
        meta = _stock("META", 600e8);

        factory = new LeashFactory(desk);

        vm.prank(alice);
        faucet.claim();
        address[] memory assets = new address[](3);
        assets[0] = address(aapl);
        assets[1] = address(nvda);
        assets[2] = address(tsla);
        uint16[] memory caps = new uint16[](3);
        caps[0] = 4000;
        caps[1] = 3000;
        caps[2] = 2000;
        vm.startPrank(alice);
        usd.approve(address(factory), 10_000e6);
        vault = LeashVault(factory.createVault(agent, assets, caps, _mandate(), 10_000e6));
        vm.stopPrank();
    }

    /// @dev Live Base networks already have every B20 feature on, so run with `--fork-url base_sepolia`. On a bare
    ///      local EVM, fall back to the registry admin (Foundry's native precompile honours `admin()`).
    function _activateIfNeeded(string memory feature) internal {
        bytes32 id = keccak256(bytes(feature));
        if (StdPrecompiles.ACTIVATION_REGISTRY.isActivated(id)) return;
        vm.prank(StdPrecompiles.ACTIVATION_REGISTRY.admin());
        StdPrecompiles.ACTIVATION_REGISTRY.activate(id);
    }

    function _stock(string memory ticker, int256 price) internal returns (IB20 token) {
        token = IB20(
            StdPrecompiles.B20_FACTORY.createB20(
                IB20Factory.B20Variant.ASSET,
                keccak256(bytes(ticker)),
                B20FactoryLib.encodeAssetCreateParams(
                    string.concat("Leash Test ", ticker, "c"), string.concat("t", ticker, "c"), address(this), 8
                ),
                new bytes[](0)
            )
        );
        token.grantRole(B20Constants.MINT_ROLE, address(desk));
        token.grantRole(B20Constants.BURN_ROLE, address(desk));
        token.grantRole(B20Constants.OPERATOR_ROLE, address(this));
        (uint256 id, address adapter) = hub.addFeed(address(0xC0FFEE), 8, string.concat("Coinbase ", ticker));
        _relay(id, 1, price, block.timestamp);
        desk.list(address(token), AggregatorV3Interface(adapter));
    }

    function _relay(uint256 id, uint80 round, int256 price, uint256 updatedAt) internal {
        uint256[] memory ids = new uint256[](1);
        uint80[] memory rounds = new uint80[](1);
        int256[] memory answers = new int256[](1);
        uint64[] memory started = new uint64[](1);
        uint64[] memory updated = new uint64[](1);
        ids[0] = id;
        rounds[0] = round;
        answers[0] = price;
        started[0] = uint64(updatedAt);
        updated[0] = uint64(updatedAt);
        vm.prank(agent);
        hub.relay(ids, rounds, answers, started, updated);
    }

    function _mandate() internal view returns (LeashVault.Mandate memory) {
        return LeashVault.Mandate({
            minCashBps: 500,
            maxTurnoverBps: 6000,
            turnoverWindow: 1 days,
            maxSlippageBps: 50,
            maxOracleAge: 1 days,
            cooldown: 1 hours,
            expiry: uint64(block.timestamp + 30 days)
        });
    }

    function _buy(IB20 token, uint256 usdAmount) internal pure returns (LeashVault.Trade memory) {
        return LeashVault.Trade({token: address(token), buy: true, amountIn: usdAmount, minAmountOut: 0});
    }

    function _one(LeashVault.Trade memory t) internal pure returns (LeashVault.Trade[] memory ts) {
        ts = new LeashVault.Trade[](1);
        ts[0] = t;
    }

    function _two(LeashVault.Trade memory a, LeashVault.Trade memory b)
        internal
        pure
        returns (LeashVault.Trade[] memory ts)
    {
        ts = new LeashVault.Trade[](2);
        ts[0] = a;
        ts[1] = b;
    }

    function test_setup() public view {
        assertEq(usd.decimals(), 6);
        assertEq(aapl.decimals(), 8);
        assertEq(vault.owner(), alice);
        assertEq(vault.agent(), agent);
        assertEq(vault.nav(), 10_000e6);
        assertEq(factory.vaultsOf(alice)[0], address(vault));
        assertEq(factory.vaultsByAgent(agent)[0], address(vault));
        (uint80 r, int256 a,,,) = AggregatorV3Interface(address(desk.feedOf(address(aapl)))).latestRoundData();
        assertEq(r, 1);
        assertEq(a, 200e8);
    }

    function test_rebalanceWithinMandate() public {
        vm.prank(agent);
        vault.rebalance(_two(_buy(aapl, 3000e6), _buy(nvda, 2000e6)), keccak256("note"), "ipfs://note");
        assertEq(vault.epoch(), 1);
        // 3000 USD at 200 USD/share minus 10 bps spread
        assertEq(aapl.balanceOf(address(vault)), 15e8 * 9990 / 10_000);
        assertEq(usd.balanceOf(address(vault)), 5000e6);
        (uint256 cash, uint256 total, LeashVault.Holding[] memory hs) = vault.snapshot();
        assertEq(cash, 5000e6);
        assertApproxEqAbs(total, 10_000e6 - 5e6, 10);
        assertEq(hs[0].symbol, "tAAPLc");
        assertApproxEqAbs(hs[0].weightBps, 2997, 1);
        assertEq(usd.totalSupply(), 5000e6);
    }

    function test_revertWeightCap() public {
        vm.prank(agent);
        vm.expectPartialRevert(LeashVault.WeightCapExceeded.selector);
        vault.rebalance(_one(_buy(tsla, 2500e6)), bytes32(0), "");
    }

    function test_revertTurnover() public {
        vm.prank(agent);
        vault.rebalance(_two(_buy(aapl, 3000e6), _buy(nvda, 2500e6)), bytes32(0), "");
        vm.warp(block.timestamp + 2 hours);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(LeashVault.TurnoverExceeded.selector, 7000e6, 6000e6));
        vault.rebalance(_one(_buy(tsla, 1500e6)), bytes32(0), "");
    }

    function test_turnoverWindowResets() public {
        vm.prank(agent);
        vault.rebalance(_two(_buy(aapl, 3000e6), _buy(nvda, 2500e6)), bytes32(0), "");
        vm.warp(block.timestamp + 1 days);
        _relay(2, 2, 350e8, block.timestamp);
        vm.prank(agent);
        vault.rebalance(_one(_buy(tsla, 1500e6)), bytes32(0), "");
        assertEq(vault.epoch(), 2);
    }

    function test_revertCashFloor() public {
        LeashVault.Mandate memory m = _mandate();
        m.maxTurnoverBps = 10_000;
        vm.prank(alice);
        vault.setMandate(m);
        vm.prank(agent);
        vm.expectPartialRevert(LeashVault.CashFloorBreached.selector);
        LeashVault.Trade[] memory ts = new LeashVault.Trade[](3);
        ts[0] = _buy(aapl, 3900e6);
        ts[1] = _buy(nvda, 2900e6);
        ts[2] = _buy(tsla, 1990e6 + 800e6);
        vault.rebalance(ts, bytes32(0), "");
    }

    function test_revertStaleOracle() public {
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(agent);
        vm.expectPartialRevert(LeashVault.StaleOracle.selector);
        vault.rebalance(_one(_buy(aapl, 1000e6)), bytes32(0), "");
    }

    function test_revertAssetNotAllowed() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(LeashVault.AssetNotAllowed.selector, address(meta)));
        vault.rebalance(_one(_buy(meta, 100e6)), bytes32(0), "");
    }

    function test_revertSlippage() public {
        desk.setParams(100, 4 days);
        vm.prank(agent);
        vm.expectPartialRevert(LeashVault.SlippageExceeded.selector);
        vault.rebalance(_one(_buy(aapl, 1000e6)), bytes32(0), "");
    }

    function test_agentMinOutIsEnforced() public {
        LeashVault.Trade memory t = _buy(aapl, 1000e6);
        t.minAmountOut = 5e8 + 1;
        vm.prank(agent);
        vm.expectPartialRevert(LeashVault.SlippageExceeded.selector);
        vault.rebalance(_one(t), bytes32(0), "");
    }

    function test_revertCooldownPausedExpiredNotAgent() public {
        vm.prank(agent);
        vault.rebalance(_one(_buy(aapl, 1000e6)), bytes32(0), "");
        vm.prank(agent);
        vm.expectPartialRevert(LeashVault.CooldownActive.selector);
        vault.rebalance(_one(_buy(aapl, 1000e6)), bytes32(0), "");

        vm.expectRevert(LeashVault.NotAgent.selector);
        vault.rebalance(_one(_buy(aapl, 1000e6)), bytes32(0), "");

        vm.warp(block.timestamp + 2 hours);
        vm.prank(alice);
        vault.setPaused(true);
        vm.prank(agent);
        vm.expectRevert(LeashVault.AgentPaused.selector);
        vault.rebalance(_one(_buy(aapl, 1000e6)), bytes32(0), "");

        vm.prank(alice);
        vault.setPaused(false);
        vm.warp(START + 30 days);
        vm.prank(agent);
        vm.expectPartialRevert(LeashVault.MandateExpired.selector);
        vault.rebalance(_one(_buy(aapl, 1000e6)), bytes32(0), "");
    }

    function test_sellAndCapZeroMeansSellOnly() public {
        vm.prank(agent);
        vault.rebalance(_one(_buy(aapl, 3000e6)), bytes32(0), "");
        vm.prank(alice);
        vault.setCap(address(aapl), 0);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(LeashVault.BuyNotAllowed.selector, address(aapl)));
        vault.rebalance(_one(_buy(aapl, 100e6)), bytes32(0), "");

        uint256 held = aapl.balanceOf(address(vault));
        vm.prank(agent);
        vault.rebalance(
            _one(LeashVault.Trade({token: address(aapl), buy: false, amountIn: held, minAmountOut: 0})), bytes32(0), ""
        );
        assertEq(aapl.balanceOf(address(vault)), 0);
        assertApproxEqAbs(usd.balanceOf(address(vault)), 10_000e6 - 6e6, 1e6);
    }

    function test_ownerAlwaysExits() public {
        vm.prank(agent);
        vault.rebalance(_two(_buy(aapl, 3000e6), _buy(nvda, 2000e6)), bytes32(0), "");

        vm.prank(agent);
        vm.expectRevert(LeashVault.NotOwner.selector);
        vault.withdrawAll(agent);

        vm.startPrank(alice);
        vault.setPaused(true);
        vault.withdrawAll(alice);
        vm.stopPrank();
        assertEq(vault.nav(), 0);
        assertEq(usd.balanceOf(alice), 5000e6);
        assertEq(aapl.balanceOf(alice), 15e8 * 9990 / 10_000);
    }

    function test_multiplierChangesSharesNotValue() public {
        vm.prank(agent);
        vault.rebalance(_one(_buy(aapl, 2000e6)), bytes32(0), "");
        uint256 navBefore = vault.nav();
        IB20Asset(address(aapl)).updateUIMultiplier(1.02e18, block.timestamp + 60);
        vm.warp(block.timestamp + 61);
        (,, LeashVault.Holding[] memory hs) = vault.snapshot();
        assertEq(hs[0].ui, hs[0].raw * 102 / 100);
        assertEq(vault.nav(), navBefore);
    }

    function test_createVaultWithPermit() public {
        address bob = vm.addr(0xB0B);
        vm.prank(bob);
        faucet.claim();
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usd.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                        bob,
                        address(factory),
                        4000e6,
                        usd.nonces(bob),
                        deadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, digest);
        address[] memory assets = new address[](1);
        assets[0] = address(meta);
        uint16[] memory caps = new uint16[](1);
        caps[0] = 9000;
        vm.prank(bob);
        address v2 = factory.createVaultWithPermit(agent, assets, caps, _mandate(), 4000e6, deadline, v, r, s);
        assertEq(LeashVault(v2).nav(), 4000e6);
        assertEq(LeashVault(v2).owner(), bob);
        assertEq(factory.vaultCount(), 2);
    }

    function test_mirrorSkipsOldAndBadRounds() public {
        _relay(0, 1, 999e8, block.timestamp);
        (, int256 a,,,) = AggregatorV3Interface(address(desk.feedOf(address(aapl)))).latestRoundData();
        assertEq(a, 200e8);
        _relay(0, 5, -1, block.timestamp);
        assertEq(hub.latestRound(0), 1);
        _relay(0, 6, 210e8, block.timestamp + 1 hours);
        assertEq(hub.latestRound(0), 1);
        _relay(0, 7, 210e8, block.timestamp);
        assertEq(hub.latestRound(0), 7);
        (, int256 b,,,) = MirrorFeed(address(desk.feedOf(address(aapl)))).getRoundData(1);
        assertEq(b, 200e8);
    }

    function test_faucetCooldown() public {
        vm.prank(alice);
        vm.expectPartialRevert(UsdFaucet.TooSoon.selector);
        faucet.claim();
    }

    function testFuzz_agentCannotPushAboveCap(uint256 amount) public {
        amount = bound(amount, 1e6, 5000e6);
        vm.prank(agent);
        try vault.rebalance(_one(_buy(tsla, amount)), bytes32(0), "") {
            (,, LeashVault.Holding[] memory hs) = vault.snapshot();
            assertLe(hs[2].weightBps, 2000);
        } catch {}
    }
}
