# ArbExecutor — atomic flash-swap executor for Arb-Me-Now

Runs a closed 2–4 leg cycle (PulseX v1/v2, 9mm v2, LibertySwap V3) in one transaction. Leg 0 is a flash swap, so no capital is needed; the tx reverts `NoProfit` unless it returns input + `minProfit`. **Unaudited — use small sizes.**

## Roles (v4.9)
| Role | Can | Cannot |
|---|---|---|
| `owner` (deployer, immutable) | `execute`, `withdraw`, `setKeeper` | be changed |
| `keeper` (optional bot key) | `execute` | `withdraw`, `setKeeper`, receive profit |

Profit is always paid to `owner`. `setKeeper(address(0))` revokes the keeper.

## Build / test / deploy
`foundry.toml` pins solc 0.8.24, evm `paris`, optimizer 200 runs, so the bytecode is reproducible and matches the one embedded in the scanner (keccak shown in the Deploy kit panel).

```bash
forge install foundry-rs/forge-std --no-git   # if lib/ is missing
forge test --fork-url https://rpc.pulsechain.com -vv   # 14 tests
```

**Deploy, easiest:** scanner → Inspect a route → Trade Companion → 🦊 Connect Wallet → 🚀 **Deploy ArbExecutor** (signed in your wallet; the page never sees keys). Then **Set keeper** if you run a bot.

**Deploy, CLI alternative (your own machine):** `forge create src/ArbExecutor.sol:ArbExecutor --rpc-url https://rpc.pulsechain.com --interactive --broadcast` (prompts for the key; never paste keys into files or chats).

See WHITEPAPER.md §3.7 and §3.11.
