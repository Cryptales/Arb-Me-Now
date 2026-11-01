# ArbExecutor — atomic flash-swap executor for Arb-Me-Now

Runs a closed 2–4 leg cycle (PulseX v1/v2, 9mm v2, LibertySwap V3) in one transaction. Leg 0 is a flash swap, so no capital is needed; the tx reverts `NoProfit` unless it returns input + `minProfit`. Owner-only. **Unaudited — use small sizes.**

```bash
forge install foundry-rs/forge-std --no-git   # if lib/ is missing
forge test -vv                                 # forks https://rpc.pulsechain.com (11 tests)
forge create src/ArbExecutor.sol:ArbExecutor --rpc-url https://rpc.pulsechain.com --private-key <YOUR_KEY> --broadcast
```

Then paste the deployed address into the scanner's Trade Companion → Atomic execution panel, Build calldata, Dry run, and send from the owner wallet. See WHITEPAPER.md §3.7.
