// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ArbExecutor — atomic flash-swap cycle executor for Arb-Me-Now (PulseChain)
/// @notice Executes a closed cycle S -> ... -> S across 2-4 pools in ONE transaction.
///         Leg 0 is taken as a flash swap (tokens out first, paid back at the end), so
///         no starting capital is needed. If the cycle returns less than
///         amountIn + minProfit, the whole transaction reverts and only gas is lost.
/// @dev v5.5.0 adds executeAndPay() — a bundle-submission variant that pays a MEV builder
///      a tip (tipBps of realized profit, unwrapped WPLS -> native PLS) to its payment router
///      BEFORE the owner is paid, enabling eth_sendBundle inclusion. The minProfit guard still
///      runs first, so an unprofitable cycle reverts and never pays a tip. Plain execute() is
///      unchanged and never tips. The owner wallet and keeper logic are identical to v4.9.
/// @dev Supported pools (verified on-chain 2026-11-01):
///      - PulseX v1/v2 pairs: swap(uint,uint,address,bytes) -> uniswapV2Call
///      - 9mm v2 pairs:       swap(uint,uint,address,bytes) -> pancakeCall
///      - LibertySwap V3:     swap(address,bool,int256,uint160,bytes) -> libertyV3SwapCallback
///      Leg encoding (uint256): bits 0-159 pool | 160-167 kind (0 = v2, 1 = v3)
///      | 168-175 zeroForOne (1 = token0 in) | 176-191 v2 fee in bps (29 PulseX, 25 9mm).
///      Fee-on-transfer / rebasing tokens are NOT supported.
interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// @dev Wrapped Pulse (WPLS) is a standard WETH9 fork. We only need to unwrap a slice of
///      realized profit into native PLS so it can be paid to a builder's payment router.
interface IWPLS is IERC20 {
    function withdraw(uint256) external;
}

interface IPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IV2Pair is IPool {
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IV3Pool is IPool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

contract ArbExecutor {
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287233952253283163906958589697;
    uint256 internal constant KIND_V2 = 0;
    uint256 internal constant KIND_V3 = 1;
    /// @dev Hard ceiling on the builder tip: never more than 50% of realized profit.
    uint256 internal constant MAX_TIP_BPS = 5000;

    address public immutable owner;
    /// @notice Wrapped Pulse. Realized profit is held in the start token; for bundle mode the
    ///         start token must be WPLS, a slice of which is unwrapped to native PLS for the tip.
    address public immutable WPLS;
    /// @notice Builder tip as a fraction of realized profit, in basis points (1000 = 10%).
    ///         Only applied by executeAndPay(); plain execute() never tips. Owner-settable, capped.
    uint256 public tipBps;
    /// @notice Optional bot key (v4.9 keeper role): may call execute() only. It can never
    ///         withdraw, and profits always go to `owner`. Zero = no keeper.
    address public keeper;

    /// @dev The only pool allowed to call back right now (zero when idle).
    address private _expected;
    /// @dev 1 = idle, 2 = executing.
    uint256 private _status = 1;

    error NotOwner();
    error NotAuthorized();
    error Expired();
    error BadRoute();
    error BadCallback();
    error Busy();
    error TransferFailed();
    /// @dev returned/required are in start-token units (either at repayment or at the final profit check).
    error NoProfit(uint256 returned, uint256 required);
    /// @dev executeAndPay() requires the cycle's start token to be WPLS so the tip can be unwrapped.
    error NotWpls();
    /// @dev The builder payment-router call reverted.
    error PayFailed();
    /// @dev Attempted to set tipBps above MAX_TIP_BPS.
    error TipTooHigh();

    event Executed(address indexed token, uint256 amountIn, uint256 profit, uint256 legs);
    event KeeperSet(address indexed previous, address indexed current);
    event TipBpsSet(uint256 previous, uint256 current);
    /// @notice Emitted when a builder tip is paid out of realized profit (bundle mode only).
    event BuilderPaid(address indexed router, uint256 tip, uint256 targetBlock, address proposerRecipient);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOwnerOrKeeper() {
        if (msg.sender != owner && (msg.sender != keeper || keeper == address(0))) revert NotAuthorized();
        _;
    }

    /// @param wpls       Canonical Wrapped Pulse address (0xA1077a294dDE1B09bB078844df40758a5D0f9a27).
    /// @param initialTip  Starting builder tip in basis points (e.g. 1000 = 10%); capped at MAX_TIP_BPS.
    constructor(address wpls, uint256 initialTip) {
        if (initialTip > MAX_TIP_BPS) revert TipTooHigh();
        owner = msg.sender;
        WPLS = wpls;
        tipBps = initialTip;
    }

    /// @notice Update the builder tip fraction (owner only); capped at MAX_TIP_BPS (50%).
    function setTipBps(uint256 newTipBps) external onlyOwner {
        if (newTipBps > MAX_TIP_BPS) revert TipTooHigh();
        emit TipBpsSet(tipBps, newTipBps);
        tipBps = newTipBps;
    }

    /// @dev Accept native PLS unwrapped from WPLS (via WPLS.withdraw) so it can be tipped out.
    receive() external payable {}

    // ------------------------------------------------------------------ entry point

    /// @param legs      2-4 packed legs forming a closed cycle (see header).
    /// @param amountIn  Amount of the start token S fed into leg 0 (flash-borrowed).
    /// @param minProfit Minimum S that must be left over after repaying leg 0; otherwise revert.
    /// @param deadline  Unix timestamp after which the call reverts.
    /// @return profit   S sent to the owner (never to the keeper).
    function execute(uint256[] calldata legs, uint256 amountIn, uint256 minProfit, uint256 deadline)
        external
        onlyOwnerOrKeeper
        returns (uint256 profit)
    {
        address tokenS;
        (tokenS, profit) = _runCycle(legs, amountIn, minProfit, deadline);
        if (profit > 0) _pay(tokenS, owner, profit);
        emit Executed(tokenS, amountIn, profit, legs.length);
    }

    /// @notice Same atomic cycle as execute(), but pays a builder tip (a slice of realized profit,
    ///         `tipBps`) to a MEV builder's payment router before sending the rest to the owner.
    ///         Used for bundle submission (eth_sendBundle). The start token MUST be WPLS.
    /// @dev The minProfit guard still fires first: a cycle that does not clear minProfit reverts
    ///      and NO tip is ever paid. The tip is bounded by tipBps (<= 50%), so net >= profit/2 > 0.
    ///      The router + per-block fields are passed as calldata because BlockFerret's
    ///      SearcherPaymentRouter address and per-block context are fetched live, not fixed.
    /// @param paymentRouter      BlockFerret SearcherPaymentRouter (fetched via getSearcherTerms).
    /// @param paymentId          Caller-chosen nonzero id, surfaced in the router's InclusionPaid event.
    /// @param targetBlock        Block the bundle targets (from the builder context).
    /// @param expectedParent     Parent hash the bundle is built on (from the builder context).
    /// @param proposerRecipient  Validator payout recipient (from the builder context).
    /// @return profit            Net S sent to the owner (realized profit minus the builder tip).
    function executeAndPay(
        uint256[] calldata legs,
        uint256 amountIn,
        uint256 minProfit,
        uint256 deadline,
        address paymentRouter,
        bytes32 paymentId,
        uint256 targetBlock,
        bytes32 expectedParent,
        address payable proposerRecipient
    ) external onlyOwnerOrKeeper returns (uint256 profit) {
        address tokenS;
        (tokenS, profit) = _runCycle(legs, amountIn, minProfit, deadline); // profit = realized (pre-tip)
        if (tokenS != WPLS) revert NotWpls();

        uint256 tip = (profit * tipBps) / 10000; // tipBps <= 5000, so tip <= realized/2
        if (tip > 0) {
            _payBuilder(paymentRouter, tip, paymentId, targetBlock, expectedParent, proposerRecipient);
        }

        profit -= tip; // >= 0; the Executed event reports the owner's net receipt
        if (profit > 0) _pay(tokenS, owner, profit);
        emit Executed(tokenS, amountIn, profit, legs.length);
    }

    /// @dev Unwrap `tip` WPLS to native PLS and forward it to the builder's payment router.
    function _payBuilder(
        address router,
        uint256 tip,
        bytes32 paymentId,
        uint256 targetBlock,
        bytes32 expectedParent,
        address proposerRecipient
    ) internal {
        IWPLS(WPLS).withdraw(tip); // WPLS -> native PLS
        (bool ok,) = router.call{value: tip}(
            abi.encodeWithSignature(
                "pay(bytes32,uint256,bytes32,address)", paymentId, targetBlock, expectedParent, proposerRecipient
            )
        );
        if (!ok) revert PayFailed();
        emit BuilderPaid(router, tip, targetBlock, proposerRecipient);
    }

    /// @dev The shared atomic cycle: validate continuity, flash leg 0, run the rest, and enforce
    ///      the minProfit guard. Returns the start token and realized profit (held by this contract,
    ///      NOT yet paid out). Resets reentrancy state before returning.
    function _runCycle(uint256[] calldata legs, uint256 amountIn, uint256 minProfit, uint256 deadline)
        internal
        returns (address tokenS, uint256 profit)
    {
        if (block.timestamp > deadline) revert Expired();
        if (_status != 1) revert Busy();
        uint256 n = legs.length;
        if (n < 2 || n > 4 || amountIn == 0) revert BadRoute();

        // Token continuity: out(i) == in(i+1) and the cycle closes on S.
        tokenS = _tokenIn(legs[0]);
        address cur = _tokenOut(legs[0]);
        for (uint256 i = 1; i < n; ++i) {
            if (_tokenIn(legs[i]) != cur) revert BadRoute();
            cur = _tokenOut(legs[i]);
        }
        if (cur != tokenS) revert BadRoute();

        uint256 before = IERC20(tokenS).balanceOf(address(this));
        _status = 2;
        _flashFirst(legs, amountIn);
        _status = 1;
        _expected = address(0);

        uint256 afterBal = IERC20(tokenS).balanceOf(address(this));
        if (afterBal < before + minProfit) revert NoProfit(afterBal > before ? afterBal - before : 0, minProfit);
        profit = afterBal - before;
    }

    /// @notice Set or replace the keeper; pass address(0) to revoke.
    function setKeeper(address newKeeper) external onlyOwner {
        emit KeeperSet(keeper, newKeeper);
        keeper = newKeeper;
    }

    /// @notice Recover any token held by the contract (owner only; the keeper cannot call this).
    function withdraw(address token, uint256 amount) external onlyOwner {
        _pay(token, owner, amount);
    }

    /// @notice Recover any stray native PLS (e.g. a dust remainder from WPLS.withdraw) to the owner.
    function sweepNative() external onlyOwner {
        uint256 bal = address(this).balance;
        if (bal > 0) {
            (bool ok,) = payable(owner).call{value: bal}("");
            if (!ok) revert TransferFailed();
        }
    }

    // ------------------------------------------------------------------ flash leg

    function _flashFirst(uint256[] calldata legs, uint256 amountIn) internal {
        uint256 leg = legs[0];
        address pool = _pool(leg);
        bool zf = _zeroForOne(leg);
        bytes memory data = abi.encode(legs, amountIn);
        _expected = pool;
        if (_kind(leg) == KIND_V2) {
            uint256 out = _v2AmountOut(pool, zf, amountIn, _feeBps(leg));
            if (out == 0) revert BadRoute();
            IV2Pair(pool).swap(zf ? 0 : out, zf ? out : 0, address(this), data);
        } else {
            IV3Pool(pool).swap(address(this), zf, int256(amountIn), zf ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1, data);
        }
    }

    /// @dev v2 flash callback (PulseX uses uniswapV2Call, 9mm uses pancakeCall).
    function uniswapV2Call(address sender, uint256 a0, uint256 a1, bytes calldata data) external {
        _v2Callback(sender, a0, a1, data);
    }

    function pancakeCall(address sender, uint256 a0, uint256 a1, bytes calldata data) external {
        _v2Callback(sender, a0, a1, data);
    }

    function _v2Callback(address sender, uint256 a0, uint256 a1, bytes calldata data) internal {
        if (msg.sender != _expected || sender != address(this) || _status != 2) revert BadCallback();
        _expected = address(0);
        (uint256[] memory legs, uint256 amountIn) = abi.decode(data, (uint256[], uint256));
        uint256 out = a0 > 0 ? a0 : a1;
        uint256 back = _runRest(legs, out);
        if (back < amountIn) revert NoProfit(back, amountIn);
        // Repay leg 0 in the start token; the pair's K check accepts this (flash swap).
        _pay(_tokenIn(legs[0]), msg.sender, amountIn);
    }

    /// @dev LibertySwap V3 callback: either the flash leg (data = legs, amountIn)
    ///      or a normal later leg (data = 32-byte tokenIn).
    function libertyV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (msg.sender != _expected || _status != 2) revert BadCallback();
        _expected = address(0);
        bool zf = amount0Delta > 0; // the positive delta is what we owe
        uint256 owed = uint256(zf ? amount0Delta : amount1Delta);
        if (data.length == 32) {
            _pay(abi.decode(data, (address)), msg.sender, owed);
        } else {
            (uint256[] memory legs,) = abi.decode(data, (uint256[], uint256));
            uint256 out = uint256(-(zf ? amount1Delta : amount0Delta));
            uint256 back = _runRest(legs, out);
            if (back < owed) revert NoProfit(back, owed);
            _pay(_tokenIn(legs[0]), msg.sender, owed);
        }
    }

    // ------------------------------------------------------------------ normal legs

    /// @return amount Start token returned by the last leg.
    function _runRest(uint256[] memory legs, uint256 amount) internal returns (uint256) {
        for (uint256 i = 1; i < legs.length; ++i) {
            amount = _swapExact(legs[i], amount);
        }
        return amount;
    }

    function _swapExact(uint256 leg, uint256 amountIn) internal returns (uint256 out) {
        address pool = _pool(leg);
        bool zf = _zeroForOne(leg);
        if (_kind(leg) == KIND_V2) {
            out = _v2AmountOut(pool, zf, amountIn, _feeBps(leg));
            if (out == 0) revert BadRoute();
            _pay(_tokenIn(leg), pool, amountIn);
            IV2Pair(pool).swap(zf ? 0 : out, zf ? out : 0, address(this), "");
        } else {
            _expected = pool;
            (int256 d0, int256 d1) = IV3Pool(pool).swap(
                address(this), zf, int256(amountIn), zf ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1, abi.encode(_tokenIn(leg))
            );
            out = uint256(-(zf ? d1 : d0));
        }
    }

    // ------------------------------------------------------------------ helpers

    function _v2AmountOut(address pair, bool zf, uint256 amountIn, uint256 feeBps) internal view returns (uint256) {
        (uint112 r0, uint112 r1,) = IV2Pair(pair).getReserves();
        (uint256 rIn, uint256 rOut) = zf ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 inWithFee = amountIn * (10000 - feeBps);
        return (inWithFee * rOut) / (rIn * 10000 + inWithFee);
    }

    function _pay(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _pool(uint256 leg) internal pure returns (address) {
        return address(uint160(leg));
    }

    function _kind(uint256 leg) internal pure returns (uint256) {
        return (leg >> 160) & 0xff;
    }

    function _zeroForOne(uint256 leg) internal pure returns (bool) {
        return (leg >> 168) & 0xff == 1;
    }

    function _feeBps(uint256 leg) internal pure returns (uint256 f) {
        f = (leg >> 176) & 0xffff;
        if (f >= 10000) revert BadRoute();
    }

    function _tokenIn(uint256 leg) internal view returns (address) {
        return _zeroForOne(leg) ? IPool(_pool(leg)).token0() : IPool(_pool(leg)).token1();
    }

    function _tokenOut(uint256 leg) internal view returns (address) {
        return _zeroForOne(leg) ? IPool(_pool(leg)).token1() : IPool(_pool(leg)).token0();
    }
}
