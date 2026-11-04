// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ArbExecutor, IERC20, IPool, IV2Pair, IV3Pool} from "../src/ArbExecutor.sol";

/// @dev Moves a pool's price on the fork so a real arbitrage gap exists.
contract Dumper {
    function v2(address pair, address tokenIn, uint256 amountIn, uint256 feeBps) external {
        bool zf = IPool(pair).token0() == tokenIn;
        (uint112 r0, uint112 r1,) = IV2Pair(pair).getReserves();
        (uint256 rIn, uint256 rOut) = zf ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 inFee = amountIn * (10000 - feeBps);
        uint256 out = inFee * rOut / (rIn * 10000 + inFee);
        IERC20(tokenIn).transfer(pair, amountIn);
        IV2Pair(pair).swap(zf ? 0 : out, zf ? out : 0, address(this), "");
    }

    function v3(address pool, address tokenIn, uint256 amountIn) external {
        bool zf = IPool(pool).token0() == tokenIn;
        IV3Pool(pool).swap(
            address(this), zf, int256(amountIn), zf ? 4295128740 : 1461446703485210103287233952253283163906958589696, abi.encode(tokenIn)
        );
    }

    function libertyV3SwapCallback(int256 a0, int256 a1, bytes calldata data) external {
        IERC20(abi.decode(data, (address))).transfer(msg.sender, uint256(a0 > 0 ? a0 : a1));
    }
}

contract ArbExecutorForkTest is Test {
    address constant WPLS = 0xA1077a294dDE1B09bB078844df40758a5D0f9a27;
    address constant PLSX = 0x95B303987A60C71504D99Aa1b13B4DA07b0790ab;
    address constant DAI = 0xefD766cCb38EaF1dfd701853BFCe31359239F305;

    address constant PX1_WPLS_PLSX = 0x1b45b9148791d3a104184Cd5DFE5CE57193a3ee9;
    address constant PX2_WPLS_PLSX = 0x149B2C629e652f2E89E11cd57e5d4D77ee166f9F;
    address constant MM_WPLS_PLSX = 0xAB98231E4BC4b5cE613957cE78814661571C83A1;
    address constant LV3_WPLS_PLSX_025 = 0x90592BD1c2Dc2B37833d89A31a41B811C08a5cad;
    address constant PX2_WPLS_USDC = 0x8eBe62D5e9D26b637673d91f56900233d6A4910d;
    address constant PX2_USDC_DAI = 0x52CA8c5C6A5c7C56cF5E01bdE9473B3B7F7c0b1e;
    address constant PX1_WPLS_DAI = 0xE56043671df55dE5CDf8459710433C10324DE0aE;

    ArbExecutor ex;
    Dumper dumper;
    address owner = address(0xA11CE);
    address bot = address(0xB0B);

    function setUp() public {
        vm.createSelectFork(vm.envOr("PULSE_RPC", string("https://rpc.pulsechain.com")));
        vm.prank(owner);
        ex = new ArbExecutor();
        dumper = new Dumper();
    }

    // ------------------------------------------------------------ helpers

    function leg(address pool, address tokenIn, bool v3, uint256 feeBps) internal view returns (uint256) {
        uint256 zf = IPool(pool).token0() == tokenIn ? 1 : 0;
        return uint256(uint160(pool)) | (uint256(v3 ? 1 : 0) << 160) | (zf << 168) | (feeBps << 176);
    }

    function legs2(uint256 a, uint256 b) internal pure returns (uint256[] memory l) {
        l = new uint256[](2);
        l[0] = a;
        l[1] = b;
    }

    function dumpV2(address pair, uint256 feeBps, uint256 divisor) internal {
        uint256 amt = IERC20(WPLS).balanceOf(pair) / divisor;
        deal(WPLS, address(dumper), amt);
        dumper.v2(pair, WPLS, amt, feeBps);
    }

    function dumpV3(address pool, uint256 divisor) internal {
        uint256 amt = IERC20(WPLS).balanceOf(pool) / divisor;
        deal(WPLS, address(dumper), amt);
        dumper.v3(pool, WPLS, amt);
    }

    /// @dev Tries decreasing sizes and returns the profit of the first one that succeeds.
    function runBest(uint256[] memory l, uint256 startSize) internal returns (uint256 profit, uint256 size) {
        return runBestAs(owner, l, startSize);
    }

    function runBestAs(address caller, uint256[] memory l, uint256 startSize) internal returns (uint256 profit, uint256 size) {
        uint256 callerBefore = IERC20(WPLS).balanceOf(caller);
        uint256 ownerBefore = IERC20(WPLS).balanceOf(owner);
        for (size = startSize; size > 1e15; size /= 2) {
            vm.prank(caller);
            try ex.execute(l, size, 1, block.timestamp + 60) returns (uint256 p) {
                profit = p;
                break;
            } catch {}
        }
        assertGt(profit, 0, "no profitable size found");
        assertEq(IERC20(WPLS).balanceOf(owner) - ownerBefore, profit, "profit not sent to owner");
        assertEq(IERC20(WPLS).balanceOf(address(ex)), 0, "executor kept tokens");
        if (caller != owner) assertEq(IERC20(WPLS).balanceOf(caller), callerBefore, "caller got paid");
        console.log("size (WPLS wei)", size);
        console.log("profit (WPLS wei)", profit);
    }

    // ------------------------------------------------------------ live market

    function test_liveCycle_isAtomic() public {
        // Live markets currently show no profitable cycle; either way, the call must be
        // all-or-nothing: revert with NoProfit, or pay at least minProfit to the owner.
        uint256[] memory l = legs2(leg(PX2_WPLS_PLSX, WPLS, false, 29), leg(MM_WPLS_PLSX, PLSX, false, 25));
        uint256 ownerBefore = IERC20(WPLS).balanceOf(owner);
        vm.prank(owner);
        try ex.execute(l, 1000e18, 1, block.timestamp + 60) returns (uint256 p) {
            assertGe(p, 1);
            assertEq(IERC20(WPLS).balanceOf(owner) - ownerBefore, p);
        } catch (bytes memory err) {
            assertEq(bytes4(err), ArbExecutor.NoProfit.selector);
            assertEq(IERC20(WPLS).balanceOf(owner), ownerBefore);
        }
    }

    // ------------------------------------------------------------ induced gaps

    function test_v2Flash_v2_profit() public {
        dumpV2(PX2_WPLS_PLSX, 29, 20); // WPLS now cheap on PulseX v2
        uint256[] memory l = legs2(leg(MM_WPLS_PLSX, WPLS, false, 25), leg(PX2_WPLS_PLSX, PLSX, false, 29));
        runBest(l, IERC20(WPLS).balanceOf(MM_WPLS_PLSX) / 50);
    }

    function test_v3Flash_v2_profit() public {
        dumpV2(MM_WPLS_PLSX, 25, 20); // WPLS cheap on 9mm
        uint256[] memory l = legs2(leg(LV3_WPLS_PLSX_025, WPLS, true, 0), leg(MM_WPLS_PLSX, PLSX, false, 25));
        runBest(l, IERC20(WPLS).balanceOf(MM_WPLS_PLSX) / 50);
    }

    function test_v2Flash_v3_profit() public {
        dumpV3(LV3_WPLS_PLSX_025, 3); // WPLS cheap on LibertySwap V3 (deep pool: big dump)
        uint256[] memory l = legs2(leg(PX1_WPLS_PLSX, WPLS, false, 29), leg(LV3_WPLS_PLSX_025, PLSX, true, 0));
        runBest(l, IERC20(WPLS).balanceOf(LV3_WPLS_PLSX_025) / 50);
    }

    function test_triangular_profit() public {
        dumpV2(PX1_WPLS_DAI, 29, 20); // WPLS cheap vs DAI on PulseX v1
        uint256[] memory l = new uint256[](3);
        l[0] = leg(PX2_WPLS_USDC, WPLS, false, 29);
        l[1] = leg(PX2_USDC_DAI, IPool(PX2_WPLS_USDC).token0() == WPLS ? IPool(PX2_WPLS_USDC).token1() : IPool(PX2_WPLS_USDC).token0(), false, 29);
        l[2] = leg(PX1_WPLS_DAI, DAI, false, 29);
        runBest(l, IERC20(WPLS).balanceOf(PX1_WPLS_DAI) / 50);
    }

    function test_reverseOfProfitable_reverts() public {
        dumpV2(PX2_WPLS_PLSX, 29, 20);
        // Wrong direction: buy where WPLS is cheap first -> guaranteed loss.
        uint256[] memory l = legs2(leg(PX2_WPLS_PLSX, WPLS, false, 29), leg(MM_WPLS_PLSX, PLSX, false, 25));
        vm.prank(owner);
        vm.expectRevert();
        ex.execute(l, 1000e18, 0, block.timestamp + 60);
    }

    // ------------------------------------------------------------ safety

    function test_onlyOwner() public {
        uint256[] memory l = legs2(leg(PX2_WPLS_PLSX, WPLS, false, 29), leg(MM_WPLS_PLSX, PLSX, false, 25));
        vm.expectRevert(ArbExecutor.NotAuthorized.selector);
        ex.execute(l, 1e18, 0, block.timestamp + 60);
        vm.expectRevert(ArbExecutor.NotOwner.selector);
        ex.withdraw(WPLS, 1);
    }

    function test_expired() public {
        uint256[] memory l = legs2(leg(PX2_WPLS_PLSX, WPLS, false, 29), leg(MM_WPLS_PLSX, PLSX, false, 25));
        vm.prank(owner);
        vm.expectRevert(ArbExecutor.Expired.selector);
        ex.execute(l, 1e18, 0, block.timestamp - 1);
    }

    function test_openCycle_rejected() public {
        // WPLS -> PLSX -> PLSX? second leg also takes WPLS in: continuity broken.
        uint256[] memory l = legs2(leg(PX2_WPLS_PLSX, WPLS, false, 29), leg(MM_WPLS_PLSX, WPLS, false, 25));
        vm.prank(owner);
        vm.expectRevert(ArbExecutor.BadRoute.selector);
        ex.execute(l, 1e18, 0, block.timestamp + 60);
    }

    function test_strayCallbacks_rejected() public {
        uint256[] memory l = legs2(leg(PX2_WPLS_PLSX, WPLS, false, 29), leg(MM_WPLS_PLSX, PLSX, false, 25));
        bytes memory data = abi.encode(l, uint256(1e18));
        vm.expectRevert(ArbExecutor.BadCallback.selector);
        ex.uniswapV2Call(address(ex), 1, 0, data);
        vm.expectRevert(ArbExecutor.BadCallback.selector);
        ex.pancakeCall(address(ex), 1, 0, data);
        vm.expectRevert(ArbExecutor.BadCallback.selector);
        ex.libertyV3SwapCallback(1, -1, abi.encode(WPLS));
    }

    function test_withdraw() public {
        deal(WPLS, address(ex), 5e18);
        vm.prank(owner);
        ex.withdraw(WPLS, 5e18);
        assertEq(IERC20(WPLS).balanceOf(owner), 5e18);
    }

    // ------------------------------------------------------------ keeper role

    function test_keeper_canExecute_profitGoesToOwner() public {
        vm.prank(owner);
        ex.setKeeper(bot);
        assertEq(ex.keeper(), bot);
        dumpV2(PX2_WPLS_PLSX, 29, 20);
        uint256[] memory l = legs2(leg(MM_WPLS_PLSX, WPLS, false, 25), leg(PX2_WPLS_PLSX, PLSX, false, 29));
        runBestAs(bot, l, IERC20(WPLS).balanceOf(MM_WPLS_PLSX) / 50); // asserts owner paid, bot not
    }

    function test_keeper_cannotWithdraw_orSetKeeper() public {
        vm.prank(owner);
        ex.setKeeper(bot);
        deal(WPLS, address(ex), 5e18);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.NotOwner.selector);
        ex.withdraw(WPLS, 5e18);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.NotOwner.selector);
        ex.setKeeper(bot);
        assertEq(IERC20(WPLS).balanceOf(address(ex)), 5e18);
    }

    function test_keeper_revoked() public {
        vm.startPrank(owner);
        ex.setKeeper(bot);
        ex.setKeeper(address(0));
        vm.stopPrank();
        assertEq(ex.keeper(), address(0));
        uint256[] memory l = legs2(leg(PX2_WPLS_PLSX, WPLS, false, 29), leg(MM_WPLS_PLSX, PLSX, false, 25));
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.NotAuthorized.selector);
        ex.execute(l, 1e18, 0, block.timestamp + 60);
        vm.expectRevert(ArbExecutor.NotAuthorized.selector); // zero address can never act as keeper
        vm.prank(address(0));
        ex.execute(l, 1e18, 0, block.timestamp + 60);
    }
}
