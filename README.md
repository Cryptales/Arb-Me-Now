# ⚡ Arb-Me-Now — PulseChain Arbitrage Scanner v5.1.2

**Free, open-source, browser-native arbitrage intelligence for the PulseChain DeFi ecosystem.**

No install · No server · No API keys · Just open the live page.

🔗 **[Launch the scanner →](https://cryptales.github.io/Arb-Me-Now/)**

---

## What it does

For a chosen start token, the scanner:
- Reads **every pool's live reserves** from PulseChain in a single Multicall3 call (`tryBlockAndAggregate` at `0xcA11…CA11`), so all numbers come from the same block.
- Tests every **two-pool round trip** (S → Y → S) across PulseX v1, PulseX v2, 9mm v2, and LibertySwap V3.
- Finds the **optimal trade size** using ternary search on the concave profit curve.
- Shows profit at the optimal size and at **your own size**.
- Gets live **LibertySwap bridge quotes** for USDC and WETH from PulseChain to Ethereum, compared against a USD reference price.

All math is exact BigInt arithmetic — no floating-point rounding errors.

---

## Verified parameters

| Venue | Factory | Fee |
|---|---|---|
| PulseX v1 | `0x1715a3E4A142d8b698131108995174F37aEBA10D` | 0.29% |
| PulseX v2 | `0x29eA7545DEf87022BAdc76323F373EA1e707C523` | 0.29% |
| 9mm v2 | `0x3a0Fa7884dD93f3cd234bBE2A0958Ef04b05E13b` | 0.25% |
| LibertySwap V3 | `0x796fcbDC956b85797EFe21145Aa97599B7FB36a6` | 0.01 / 0.05 / 0.25 / 1% |

All addresses and fees were verified on-chain against live contract data. See the **Docs & Audit** tab in the app for the full corrections log.

---

📘 **Full process manual / white paper:** [PDF edition](Arb-Me-Now_WhitePaper.pdf) · [Markdown](WHITEPAPER.md)

## How to use

1. Open **[cryptales.github.io/Arb-Me-Now/](https://cryptales.github.io/Arb-Me-Now/)** — it scans automatically on load.
2. Choose your **start token**, enter your **trade size**, and set a min profit threshold.
3. Toggle venues on/off to narrow the search.
4. Click **Inspect** on any row to see both legs, pool addresses, reserves, and the exact integer calculation.
5. Tick **🔔 Alert on new profitable route** plus **Auto-refresh every 15 s** to get a sound + browser notification when a net-profitable route appears.
6. Use the **LibertySwap bridge** panel to check whether USDC or WETH on PulseChain is priced below its Ethereum equivalent.

---

## Server scanner + Telegram alerts (v5.0)

`server/scanner.js` runs the same engine 24/7 on your own always-on machine and pings you on Telegram when a route is net-positive after estimated gas. It **only alerts and never trades**: you still Dry Run and Send in the Trade Companion. Quick start (Node 18+, no npm install):

```
cp server/config.example.json server/config.json   # add your @BotFather token + chat ID
node server/scanner.js --dry --once                # one test scan; prints alerts, sends nothing
node server/scanner.js                             # run continuously (use screen/tmux/pm2 or a VPS)
```

`config.json` is git-ignored, so your token stays private. Full guide: [server/README.md](server/README.md) · White Paper §3.14.

**New in v5.0.1 — scan log.** Each scan also appends the single best route it saw that scan — even when net-negative after gas — to `server/scan_log.csv` (git-ignored, on by default via `csv_log` in `config.json`). It's a 19-column near-miss history (route, pools, mid gap, optimal size + gross/net USD + bps, gas, profit at your fixed size) for studying how close the market comes to a profitable cycle over time.

## Keeper — automatic execution (v5.1)

`server/keeper.js` is the next step beyond alerts: a separate program that watches the chain **per block** and, when a route clears your profit floor, simulates the exact `execute()` call against the live ArbExecutor contract before acting. The data drives the design — profitable windows are rare (~0.23% of scans) and almost always last exactly **one block** — so it reacts within a block and sets an **on-chain minProfit guard** (default 90% of the simulated edge) so a transaction that lands after the gap closes simply reverts, losing only gas instead of trading at a loss.

**Safety first — it cannot send by default.** Simulate-only is the default (read-only, like the scanner). Sending requires three deliberate switches together: the `--live` flag, a private key (from the `KEEPER_PRIVATE_KEY` env var or a gitignored key file — never committed), and `keeper_enabled` in config — plus kill switches (max gas price, max trades/day, max daily loss, single-flight) and robust RPC (timeout/retry/fallback). Use a dedicated low-balance keeper wallet authorized on-chain via `setKeeper()`; the keeper never needs the owner key.

```
node server/keeper.js --selftest      # offline crypto self-test (sign -> ecrecover round-trip)
node server/keeper.js --simtest       # live: ABI-encode + callStatic-simulate against the live contract
node server/keeper.js --dry --once    # live: one poll cycle, logs, sends nothing
node server/keeper.js --live          # armed (requires a key + keeper_enabled); simulate-first every block
```

Signing deps (`@noble/curves` + `@noble/hashes`) are only needed for `--live` (`cd server && npm install`); simulate-only needs nothing. Full setup, the go-live checklist and the keeper CSV columns are in [server/README.md](server/README.md) · White Paper §3.15.

Since **v5.1.1** the keeper's `keeper_log.csv` records the single best route it saw on **every** block (not just when one clears the floor), mirroring the scanner's `scan_log.csv` metric columns from the identical `engine.js` fields — so a dry run can be reviewed apples-to-apples against the scanner. See the Changelog for the 20-column schema.

## Reading the results table

| Column | What it means |
|---|---|
| **Mid gap** | Raw price difference around the cycle from current pool prices, *before* fees and price impact. It is the ceiling on profit: if it is below the legs' combined fees, the route can't be profitable at any size. |
| **Optimal size → profit** | The input that maximises gross profit (exact pool maths, fees included, within safe-depth caps), then the profit at that size in the start token and in bps. |
| **Profit (USD)** | Optimal-size profit in USD. The **net after gas** line under it subtracts estimated gas and is based on the *optimal* size. |
| **At your size** | The same calculation on your exact *Your trade size*. Profit rises with size, peaks at the optimum, then falls as your own price impact grows, so this approaches the optimal profit as your size approaches the optimal size. It updates on the next scan. `exceeds safe depth` = beyond a leg's cap. |
| **Flags** | `candidate`, `3-hop triangular`, `v3 multi-tick (≤N intervals)`, `v3 in-interval (conservative cap)`; suspicious and hidden by default: `dust depth`, `gap >50%`. |

The full explanation with a worked example is in the white paper, §5.1.

## Limitations

- **2-pool round trips** and **triangular 3-hop routes** (S → Y → Z → S over three distinct pools) are checked. Triangular legs use the 10% reserve cap (v2) and multi-tick depth (v3); only profitable triangular routes are listed.
- Gas is **estimated** (live gas price × per-route gas units) and shown as net profit; MEV is not modelled.
- LibertySwap V3 depth is modelled across up to **4 tick intervals per direction** (v4.5); deeper liquidity is not modelled.
- 🔔 Alerts run in the browser only — the tab must stay open.
- Bridge checks are **non-atomic** — the cross-chain price comparison excludes gas, slippage, and bridge-crossing time. Quotes are informational only.
- The page never signs or sends. Execution is opt-in via your own deployed ArbExecutor (see `contracts/`); unaudited, use small sizes.

---

## Files

| File | Description |
|---|---|
| `index.html` | The complete scanner (single self-contained file — CSS, engine, and UI all inlined) |
| `README.md` | This file |
| `engine.js` | Scanner engine (also inlined in index.html); used by the server scanner |
| `server/` | Server scanner + Telegram alerts (`scanner.js`, v5.0) and the v5.1 keeper (`keeper.js` — per-block simulate-first auto-execution), plus `config.example.json`, `package.json`, `README.md` |

`dashboard.html` and `trade-companion.html` are older files kept for reference only. Use `index.html`.

---

## Changelog

### v5.4.0 (2026-11-15)
- **MEV protection — private / bundled submission**, driven by the **second real live fire**: route `WPLS → WETH → PLSX → WPLS`, +$2.66 sim, computed at block 28065570 and mined at 28065572 — **only 2 blocks late** (down from 16) yet **still reverted**, burning 218,843 gas fighting deep into the swaps before the on-chain `minProfit` guard caught it (realized −$0.0018, gas only, no capital lost). The v5.3.0 priority bid fixed inclusion speed; the revert proved the remaining leak is **public-mempool front-running** — our profitable tx is visible the instant we broadcast it, and a faster/atomic competitor takes the edge before our swaps settle.
- **Configurable submission layer** (`submission_mode`). **`private`** (new default) sends via BlockFerret's private RPC (`https://rpc.blockferret.win`, standard `eth_sendRawTransaction`, no auth/payment) so the tx is **held out of the public mempool** until included — directly defeating the front-run. **`public`** keeps the old v5.3.0 broadcast (for comparison/fallback). **`bundle`** (atomic `eth_sendBundle` to `https://rpc.blockferret.win/builders`, identity from env **`FLASHBOTS_IDENTITY_KEY`**) is **scaffolded but not enabled** — it needs an on-chain SearcherPaymentRouter payment the ArbExecutor does not make, so it logs a warning and **falls back to `private`**.
- **Expires harmlessly, never leaked.** Private/bundle sends use a tight `private_tx_deadline_s` (default **30 s**) for the on-chain `execute()` deadline, so a tx that isn't included promptly **expires and reverts (gas only)** instead of landing stale (logged `expired_not_included;private`). A missed private tx is **never re-broadcast** to the public mempool (that would re-expose it to front-running). All v5.2.0/v5.3.0 guardrails + receipt accounting stay in force in every mode.
- **Banner + Telegram.** The startup banner gains a **Submission** line (mode + endpoint + deadline, with the bundle-fallback note), and the `SENT` Telegram notice now names the mode and tags private sends 🔒 *out of public mempool*.
- Four new config keys (each with `_help` in `config.example.json`): `submission_mode` **private**, `private_rpc_url` **https://rpc.blockferret.win**, `bundle_rpc_url` **https://rpc.blockferret.win/builders**, `private_tx_deadline_s` **30**. The 28-column schema is unchanged — the mode is recorded in the existing outcome cell; no scanner/engine logic changed. `KEEPER_VERSION` → `v5.4.0`. **Honest status:** public + private are fully functional in code and verified offline (mode routing, banner, deadline, notices); the private path has **not yet been exercised against a real mined tx** (operator hot-swaps the live keeper after review). Bundle is scaffolded only. Verified: `node --check` passes, `node test.js` exits 0, dry `--dry --once` banners the new Submission line in SIMULATE-ONLY. See [server/README.md](server/README.md) and White Paper §3.18.
- **Daily-digest false-alarm fixed** (separate from the keeper): the "🚀 WE COULD HAVE GONE BIGGER" size-sweep headline now fires only on a genuinely meaningful size-up (1x itself a real positive fire ≥ $0.01 **and** the larger multiple nets ≥ $0.01 more), suppressing the dust / $0.00-vs-$0.00 rounding-noise cases that were lighting it daily — verified against blocks 28058961 / 28062095 / 28065571 (all now correctly suppressed).

### v5.3.0 (2026-11-14)
- **Inclusion speed + receipt accounting**, driven by the **first real live fire**: route `WPLS → pDAI → WPLS`, edge computed at block 28060232 but mined 16 blocks late at 28060248 — by inclusion the edge was gone, so the on-chain `minProfit` guard **correctly reverted** ($0 realized vs $1.45 sim, ~$0.00005 gas, no capital moved). Two lessons fixed here: our bottleneck is **inclusion speed**, and the keeper left the live row's realized/error columns **empty** on a receipt timeout.
- **Inclusion-speed priority gas.** The keeper bids a configurable multiple over base gas to land faster — `gas_priority_mult` (default **1.25×**), still clamped by the existing `max_gas_price_gwei` ceiling. A **gas-vs-edge safety guard** `max_gas_frac_of_edge` (default **0.5**) skips any fire whose priority-gas cost would exceed that fraction of the simulated edge (logged `guard:gas_vs_edge`), so a fast bid never eats the trade.
- **Receipt accounting (empty-column fix).** The live `keeper_log.csv` row is now **deferred until the receipt resolves** instead of written blank at send time. On receipt it writes realized net USD (col 19, gross from the `Executed` event minus *actual* gas = `gasUsed × effectiveGasPrice`) and the outcome (col 20: `success` / `reverted_onchain;consec=N`). On timeout (`receipt_wait_s`, default **90 s**) it writes `realized = pending`, `error = receipt_timeout` (never blank) and **re-checks the tx every cycle**, upgrading the row when the receipt lands or finalizing `receipt_timeout_final` after 10 minutes.
- **Revert accounting + circuit breaker.** Gas-only revert losses now count toward the `max_daily_loss_usd` kill-switch (real receipt gas). A **consecutive-revert circuit breaker** `consecutive_revert_limit` (default **5**) suspends live firing (falls back to sim-only, keeps scanning/logging) once that many reverts occur in a row; a mined success resets the counter.
- **Telegram now reports the final outcome** of every fire (SUCCESS w/ realized $, REVERTED w/ reason + consecutive count, or circuit-breaker trip), not just "sent".
- Four new config keys (each with `_help` in `config.example.json`): `gas_priority_mult` **1.25**, `max_gas_frac_of_edge` **0.5**, `consecutive_revert_limit` **5**, `receipt_wait_s` **90**. The 28-column schema is unchanged — only the two previously-empty live cells are now always populated; no read-only/scanner/engine logic changed. `KEEPER_VERSION` → `v5.3.0`. Verified: `node --check` passes, `node test.js` exits 0, dry `--dry --once` still banners SIMULATE-ONLY and logs identically; the new priority-gas/receipt/revert paths were validated offline (no real send). See [server/README.md](server/README.md) and White Paper §3.17.

### v5.2.0 (2026-11-14)
- **Guarded live pilot for the keeper.** `server/keeper.js` can now send **real** signed `execute()` transactions — but it **defaults OFF** and behaves exactly like the read-only dry keeper unless **all** of these line up: `live_enabled: true` (new config master switch, default `false`), the `--live` flag, a valid `KEEPER_PRIVATE_KEY` **environment variable**, and the key's **derived address matching the executor's on-chain `keeper()`**. Missing/invalid key or a signer≠`keeper()` mismatch is a **hard exit** (no silent fallback).
- **Private key is env-var only.** The file/config key source was removed — the key is read only from `KEEPER_PRIVATE_KEY` at launch and is never written to disk, logged, echoed (even masked), or committed. Only the public derived address is printed; the keeper wallet is separate from the owner wallet and authorized on-chain via `setKeeper()`.
- **Three guardrails** with `_help` keys and defaults: `max_position_usd` ($400 per-trade notional cap), `max_daily_loss_usd` ($5.00 UTC-day kill-switch over reverted-tx gas + any below-gas trade — halts sends for the rest of the day, resets at UTC midnight), and the kept `min_net_usd` $0.50 floor, all on top of the on-chain `minProfit` guard.
- **Live rows reuse the existing 28-column `keeper_log.csv`** — no schema change: a sent trade records `action = live`, the real `tx_hash`, and realized **net** USD (Executed-event profit − gas). The running `arb-keeper-dry` log is undisturbed.
- Live sends reuse the **same** `execute()` calldata the simulation validated (`packLeg` → `encodeExecute`, now+deadline). Runs as a new, separate `arb-keeper-live` process started manually with the key inline; the existing `arb-scanner`/`arb-keeper-dry` processes are untouched. Purpose: measure realized-vs-simulated profit under real mempool competition, cheaply (PulseChain gas ~$0.002–0.006/attempt). `KEEPER_VERSION` → `v5.2.0`. Verified read-only: `node --check` passes, dry mode logs identically, and the live gate hard-exits on a missing key and on a signer≠`keeper()` mismatch with the key value never appearing in output. See [server/README.md](server/README.md) and White Paper §3.16.

### v5.1.3 (2026-11-14)
- **Keeper — read-only size-sweep shadow telemetry.** On every fire (the same in-band condition as the v5.1.2 shadow) the dry keeper now runs three extra read-only `callStatic`s on the best route at **1.5×, 2× and 4×** the engine's optimal `amountIn`, each with the on-chain `minProfit` forced to **1** so the guard never masks the measurement — revealing the *true* net USD a larger trade would have returned at that size. This directly quantifies how much profit `engine.js`'s conservative adaptive V3 depth leaves on the table at large sizes during a real wide-gap event.
- **5 new `keeper_log.csv` columns** (28 total): `sweep_1_5x_net_usd`, `sweep_2x_net_usd`, `sweep_4x_net_usd` (true on-chain net USD after gas at each multiple; empty if that size reverts), `sweep_best_mult` (the winning multiple among `1x`/`1.5x`/`2x`/`4x`, where `1x` is the v5.1.2 shadow at the engine size) and `sweep_best_net_usd` (that best net value). Non-fire rows carry empty strings in all shadow/sweep cells; the schema stays aligned on every code path.
- **Strictly simulate-only** — pure `eth_call`s from the owner address that can never send a transaction, each isolated in its own `try`/`catch` so a sweep failure never breaks the cycle or the main trade path. At most three extra in-band RPC calls per fire. `KEEPER_VERSION` bumped to `v5.1.3`. No sizing, engine, or send/trade logic changed. Verified `node --check` passes and the 28-column header is intact.

### v5.1.2 (2026-11-14)
- **Shadow sizing-telemetry logger (keeper, read-only).** The dry keeper now runs **one** extra read-only `callStatic` on the single best route each block — gated to a near-miss band (`opt_net_usd >= min_profit_usd - shadow_band_usd`) — and logs the on-chain result beside the engine's own estimate. It captures engine-vs-chain side-by-side so the next real wide-gap event is self-documenting, because `engine.js`'s conservative adaptive V3 depth under-sizes profit at large optimal sizes (one historical fire: engine +$0.49 vs on-chain +$2.81, ~5.7×) which the keeper's fire-floor-gated simulation would otherwise never record.
- **3 new `keeper_log.csv` columns** (23 total): `shadow_cs_net_usd` (on-chain `callStatic` net USD at the engine's optimal size), `shadow_cs_prof_tok` (raw profit in the start token), `shadow_ratio` (`callStatic` profit ÷ engine profit; **>1 means the engine under-estimated**). **2 new config keys**: `shadow_enabled` (default on), `shadow_band_usd` (default $0.50).
- **Strictly simulate-only** — a pure `eth_call` from the owner address that can never send a transaction; adds at most one extra RPC call per block, only when in-band. No sizing or engine logic changed. Verified by syntax check plus a read-only engine run exercising `buildCalldata` + `simulateExecute` on the live best route (returns a number without sending); the live CSV and pm2 processes were not touched.
- **Site — in-app Settings guide (Docs tab).** New "⚙️ Settings guide — how to get the best results" section in the dashboard (`index.html`, `div#view-docs`, right after the White Paper box) explaining how to approach the input settings: **trade size drives V3 tick depth** (size and `#in-tickdepth` are a paired lever — raise them together), a **safety-first floor/guard mindset** (treat `opt_net_usd` as a floor, keep the dust/suspicious guards and `minProfit` on), **wait for multi-block persistence before acting**, and a **staged observe → measure → tune → lock-in** methodology for porting accurate values into `server/config.json`. Docs/UI only — no engine, keeper, or config behaviour changed.

### v5.1.1 (2026-11-14)
- **Enriched keeper telemetry — best route per block with scanner-parity metrics.** The dry keeper's `keeper_log.csv` now logs the single best route it saw on **every** block (not just a bare `none,skip` row when nothing clears the floor), mirroring the scanner's `scan_log.csv` metric columns from the identical `engine.js` fields: best route/type/pools, mid-gap %, optimal size/gross/bps, gas units/USD and optimal net USD. Every code path — no-candidate, below-floor, revert, guard-blocked, simulate/would-send, sent, errors — carries the populated best-route columns alongside the keeper's own `sim_decision` / `action` / `tx_hash` / `realized_usd` decision columns, so a dry run reviews apples-to-apples against the scanner.
- New 20-column schema (`timestamp,block,gas_price_gwei,routes_evaluated,best_route,best_type,best_pools,mid_gap_pct,opt_size_tok,opt_gross_usd,opt_bps,gas_units,gas_usd,opt_net_usd,sim_decision,sim_net_usd,action,tx_hash,realized_usd,error`). On upgrade the old `keeper_log.csv` is rotated aside so the new run starts a clean single-schema file.
- Keeper behaviour otherwise **identical**: simulate-only default, `--live` gating, kill switches, single-flight, RPC fallback, Telegram-on-execution. Tested read-only — `--dry --once` writes the new header and a fully populated best-route row on a no-opportunity block; the live dry keeper restarted onto the new code still banners SIMULATE-ONLY and writes enriched rows every block.

### v5.1 (2026-11-14)
- **New `server/keeper.js` — per-block, simulate-first automatic execution.** A separate program (not the scanner) that reuses `engine.js`, polls the chain tip, and on each new block scans, selects the best routes, ABI-encodes the exact `execute()` call and `callStatic`-simulates it against the live ArbExecutor at `0xd5da…30bd` before acting. It sends only on a simulation that returns a profit, with the on-chain `minProfit` set to **90%** of the simulated edge (`onchain_guard_frac`) so a tx that lands after the one-block gap closes reverts (losing only gas) instead of trading at a loss.
- **Safety model — simulate-only by default.** Sending requires three independent switches together: the `--live` flag, a key (`KEEPER_PRIVATE_KEY` env var or a gitignored key file), and `keeper_enabled` in config. `--dry` always forces simulate-only. Kill switches: `max_gas_price_gwei`, `tx_deadline_s`, `max_trades_per_day`, `max_daily_loss_usd`, single-flight; counters reset at UTC midnight. Robust RPC (timeout/retry/backoff/fallback). Signing libs (`@noble/curves` + `@noble/hashes`) are lazy-loaded only when live — simulate-only holds no key and imports no crypto. `--selftest` / `--simtest` / `--dry --once` flags for testing.
- Own `keeper_log.csv` (separate from `scan_log.csv`) and Telegram notifications **only on actual executions**. New keeper fields in `config.example.json`; `keeper.key` / `*.key` / `*.pem` gitignored. Keeper setup + go-live checklist in `server/README.md`; White Paper §3.15, roadmap and history.
- **Tested read-only (no key):** offline sign→ecrecover self-test (EIP-155 chainId 369); live `callStatic` simulate returning a profit at block 28,053,137; dry-run no-opportunity path; RPC fallback; and `NoProfit`/`Expired` revert decoding against the live contract. **Live send is unverified** — it needs a funded, authorized keeper key, which by design is never supplied to or requested by the tool.
- White paper §3.15 + roadmap + history updated; PDF regenerated; `index.html` rebuilt (v5.1).

### v5.0.2 (2026-11-04)
- **Alert floor in USD.** New `min_net_usd` config option (default **$0.50**) sets the minimum net-after-gas profit a route must clear before a Telegram alert fires, so hairline-positive routes worth only a few cents no longer ping you. Prompted by the first live alert (WPLS→WETH→WPLS, net $0.117).
- The CSV scan log is **unchanged** — it still records the single best route every scan regardless of this floor, and the `net_positive` column still counts truly net-positive routes (>$0), independent of the alert threshold.
- Tested live; scanner restarted. White paper §3.14 + history and config example updated; PDF regenerated.

### v5.0.1 (2026-11-04)
- **Scan-log CSV.** The server scanner now appends one row per scan to `server/scan_log.csv` recording the single best *executable* route that scan — the largest mid-gap route that clears the dust floors — even when it is net-negative after gas. 19 columns: timestamp, scan, block, gas price, routes evaluated, route + pools, mid gap, optimal size/gross/net/bps, gas estimate, and profit at your fixed trade size.
- Git-ignored and controlled by `csv_log` / `csv_path` in `config.json` (on by default). Alert logic is unchanged — this only writes a near-miss history for later analysis of which pairs, venues and gas levels come closest to profitable.
- Tested live: rows append once per scan. White paper §3.14 + history and in-app Docs note updated; PDF regenerated.

### v5.0 (2026-11-04)
- **New `server/` folder: server scanner + Telegram alerts.** `scanner.js` reuses `engine.js` on Node 18+ with no dependencies. It scans all four venues (2-pool and triangular cycles), applies the browser's suspicious/dust filters and the v4.9.3 gas model, and alerts only on routes that are net-positive after gas, de-duplicated per route (default 5 min).
- `--dry` prints alerts to the terminal instead of Telegram; `--once` runs a single scan. Live dry-run scan tested: 200 routes evaluated at block 27,970,424, 0 net-positive. Real Telegram delivery not yet tested (needs your bot token).
- Alerts only: no signing, no keys on the server. Keeper and auto-execution are planned next (v5.1).
- White paper §3.14, roadmap and history updated; PDF regenerated. In-app Docs note added.

### v4.9.4 (2026-11-04)
- **Docs: Reading the results table**: every results column explained (mid gap, optimal size → profit, profit USD + net after gas, at your size, flags with their exact labels), plus the profit-curve explanation of why *At your size* changes as your size approaches the optimum. Added to white paper §5.1 (with a worked example), the in-app Docs tab and this README. No scanner logic changed.
- White paper v4.9.4 + PDF regenerated.

### v4.9.3 (2026-11-04)
- **Gas model recalibrated on mainnet**: the per-route base rises from 150k to 210k; the costs per V2 hop (140k) and per V3 hop (230k) are unchanged. The V2×3 estimate is now 630k, against 627,914 measured on the first mainnet dry run (it was 570k, ~9% low). Every net-after-gas figure is now a little more conservative.
- White paper v4.9.3 (§3.12 model + table, §3.13, §4 step 6, limitations, history) + PDF regenerated.

### v4.9.2 (2026-11-04)
- **First mainnet deploy recorded**: ArbExecutor `0xd5da79af4c4c24f9d3afec0a1cbd761a24b130bd` (owner verified on-chain, 1,297,519 gas).
- First live `execute()` from the ZKX wallet reached the contract and passed the owner check, but it reverted `Expired()` because it was mined ~16.6 min after its 120 s deadline (cost 9.73 PLS).
- **Calldata deadline raised from 120 s to 600 s** (`now + 600 s`).
- First mainnet dry run measured 627,914 gas vs the 570k model estimate.
- White paper §3.13 added; PDF regenerated.

### v4.9.1 (2026-11-03)
- **Gas model recalibrated** from fork measurements of `ArbExecutor.execute`: V2+V2 383k, V3+V2 428k, V2+V3 573k, V2×3 346k (warm, call only); 3-leg V3 route 770,688 (full tx). Each route is now estimated as 150k + 140k per V2 hop + 230k per V3 hop, replacing the flat 250k/350k that was ~2.2× too low for V3 routes. Each row shows its gas estimate.
- **Dry run measures real gas**: after a successful simulation, `eth_estimateGas` is called for the exact transaction, and the page shows gas, PLS/USD cost and (for WPLS routes) net profit after gas.
- White paper v4.9.1 (new §3.12, §4 step 6, roadmap, history) + PDF regenerated.

### v4.9 (2026-11-03)
- ArbExecutor **keeper role**: the owner can appoint/revoke one bot key (`setKeeper`) that may only call `execute()`; `withdraw`/`setKeeper` stay owner-only; profit always goes to the owner. New error `NotAuthorized`. 3 new fork tests (14/14 pass).
- **Deploy kit** in Trade Companion: Estimate deploy cost, Deploy ArbExecutor (wallet-signed, receipt + `owner()` check, address saved locally), Read / Set / revoke keeper. Connect & Send now accepts the keeper account.
- `contracts/foundry.toml` pins solc 0.8.24, evm paris, optimizer 200; the page embeds exactly that bytecode (keccak `0x1635…1004`).
- Fork end-to-end test: deploy → set keeper → dry run → keeper execute paid the owner 52.86 WPLS, but used 770,688 gas (~218 PLS), so it would have been net-negative live; the scanner's 350k 3-hop gas assumption is too low for V3 routes (recalibration on the backlog).
- White paper v4.9 (new §3.11, §3.7 safety, §4 step 8, roadmap, history) + PDF regenerated; contracts/README rewritten.

### v4.8.1 (2026-11-03)
- Trade Companion: opt-in 🔎 **Check with Piteas** — compares the route with the Piteas aggregator's whole-market round trip (2 quotes, local cap 6 req/min, clear "Piteas unavailable" message on errors). Read-only; the scanner never depends on Piteas.
- Tide (seen in Piteas routes) identified on-chain as a Balancer-V3-style weighted pool (RISKOFF: HEX/INC/CST/PLSX/WPLS, 5/5/80/5/5 %, 0.30 % fee, small balances). Not scanned yet; documented.
- White paper v4.8.1 (new §3.10, §4 step 9, §7, roadmap incl. keeper role, history) + PDF regenerated.

### v4.8 (2026-11-01)
- Adaptive V3 tick depth: each LibertySwap V3 pool reads only as many tick intervals as the trade size needs (capacity-based, min 2), capped by a new **V3 tick depth** slider (1–8, default 4). Same-block Multicall3 reads; telemetry shows the depth range used.
- Live check: 1k WPLS → 2 intervals on deep pools; 10⁸ WPLS → 6–8; cap 1 → single-interval.
- White paper v4.8 (§2, new §3.9, §6, roadmap, history) + PDF regenerated.

### v4.7 (2026-11-01)
- New tokens: eHEX (bridged HEX), INC, plus WETH pairs — 9 new liquid pairs (WPLS/eHEX, HEX/eHEX, eHEX/DAI, WPLS/INC, PLSX/INC, INC/HEX, WETH/DAI, WETH/PLSX, WETH/HEX), verified on-chain.
- Trade Companion: opt-in 🦊 Connect & Send — switches MetaMask to PulseChain, checks executor `owner()`, sends the built calldata via the wallet, shows tx hash + explorer link. Keys never touch the page.
- White paper v4.7 (§2 discovery, new §3.8 wallet send, §7 security model, roadmap, history) + PDF regenerated.

### v4.6.1 (2026-11-01)
- Fixed stale browser tab title (was "v4.3", now correctly "v4.6").
- White paper PDF regenerated with the v4.6.1 history entry.

### v4.6 (2026-11-01)
- `contracts/src/ArbExecutor.sol`: atomic flash-swap executor (2–4 legs; PulseX v1/v2, 9mm v2, LibertySwap V3). Reverts `NoProfit` unless the cycle pays input + min profit. 11/11 fork tests pass; JS e2e shows contract profit = scanner prediction.
- Trade Companion: execution panel (packed legs, calldata builder, read-only `eth_call` dry run from the owner).
- White paper updated to v4.6.

### v4.5 (2026-11-01)
- Multi-tick LibertySwap V3 depth: up to 4 tick intervals per direction, `ticks()` read in a second Multicall3 pinned to the same block (falls back to single-interval).
- Profitability alerts: sound + browser notification + banner, once per newly profitable route (net of gas, ≥ min bps, never suspicious rows).
- White paper / process manual updated to v4.5.

### v4.4 (2026-11-01)
- Gas-adjusted net profit (live eth_gasPrice × per-route estimate: 210k + 140k/V2 hop + 230k/V3 hop since v4.9.3; dry run shows measured eth_estimateGas).
- Process manual: see [WHITEPAPER.md](WHITEPAPER.md).
- Old dashboard.html / trade-companion.html now redirect to the scanner.
- Added triangular 3-hop route search (toggle in Settings), with optimal sizing and a three-leg Trade Companion view.

### v4.3 (2026-11-01)
- Live Multicall3 reserves: all pools read at a single block.
- Real TickMath port and exact v3 math (current-interval only).
- Optimal size search: binary + ternary search.
- LibertySwap V3 pools included in cycle scan.
- LibertySwap bridge quotes panel (USDC and WETH).
- Suspicious / dust pools hidden by default (gap > 50% or capacity < $25).
- Auto-refresh toggle (15 s).
- **Fixes:** PulseX v1 factory address typo fixed; bridged USDC and DAI addresses corrected; 9mm fee corrected from 0.30% to 0.25%; real Multicall3 replaces the old multi-call approach.
