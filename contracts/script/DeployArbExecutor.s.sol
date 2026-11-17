// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";

/// @title DeployArbExecutor — one-shot deploy of the v5.5.0 ArbExecutor (bundle-mode capable).
/// @notice Deploys a FRESH ArbExecutor. The existing contract (0xd5da79af...) stays frozen and
///         untouched — this is a brand-new deployment at a new address.
///
/// ──────────────────────────────────────────────────────────────────────────
/// SECURITY (read this):
///   • The owner private key is supplied ONLY via the OWNER_PRIVATE_KEY env var, at the moment
///     you run the script. Foundry reads it into memory for the one broadcast; it is NEVER
///     written to disk, logged, or echoed by this script. Clear your shell history afterwards.
///   • The deployer (the OWNER_PRIVATE_KEY wallet) becomes the contract `owner` — so you MUST
///     run this with the ZKX OWNER key (0x38D8...B772), not the bot key.
///   • TIP_BPS is optional (defaults to 1000 = 10%); it is capped on-chain at 5000 (50%).
/// ──────────────────────────────────────────────────────────────────────────
///
/// USAGE:
///   cd contracts
///
///   # 1. Simulate (compiles + runs the deploy on a fork, broadcasts NOTHING, spends no gas):
///   OWNER_PRIVATE_KEY=0xYOUR_ZKX_OWNER_KEY \
///     forge script script/DeployArbExecutor.s.sol --rpc-url https://rpc.pulsechain.com
///
///   # 2. Real deploy (signs with the owner key and broadcasts the creation tx — SPENDS GAS):
///   OWNER_PRIVATE_KEY=0xYOUR_ZKX_OWNER_KEY \
///     forge script script/DeployArbExecutor.s.sol --rpc-url https://rpc.pulsechain.com --broadcast
///
///   # Optional: override the tip (e.g. 500 = 5%):
///   TIP_BPS=500 OWNER_PRIVATE_KEY=0x... forge script ... --broadcast
///
/// After deploy: copy the printed address into server/config.json as "executor_address",
/// authorize the keeper on the NEW contract (OWNER_PRIVATE_KEY=0x... node server/set_keeper.js
/// <BOT_ADDRESS> after pointing set_keeper.js EXECUTOR at the new address, or call setKeeper
/// directly), then hot-swap the keeper — no code edit needed.
contract DeployArbExecutor is Script {
    /// @dev Canonical Wrapped Pulse (verified on-chain: symbol "WPLS", name "Wrapped Pulse").
    address internal constant WPLS = 0xA1077a294dDE1B09bB078844df40758a5D0f9a27;

    function run() external {
        uint256 tipBps = vm.envOr("TIP_BPS", uint256(1000)); // default 10%
        require(tipBps <= 5000, "TIP_BPS > 50% cap");
        uint256 pk = vm.envUint("OWNER_PRIVATE_KEY"); // never logged
        address deployer = vm.addr(pk);

        console.log("Arb-Me-Now v5.5.0 ArbExecutor deploy");
        console.log("  deployer (becomes owner):", deployer);
        console.log("  WPLS  :", WPLS);
        console.log("  tipBps:", tipBps);

        vm.startBroadcast(pk);
        ArbExecutor ex = new ArbExecutor(WPLS, tipBps);
        vm.stopBroadcast();

        console.log("  -> ArbExecutor deployed at:", address(ex));
        console.log("     owner():", ex.owner());
        console.log("     WPLS():", ex.WPLS());
        console.log("     tipBps():", ex.tipBps());
        console.log("  Next: paste this address into server/config.json \"executor_address\", then setKeeper(bot).");
    }
}
