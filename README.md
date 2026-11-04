# ⚡ Arb-Me-Now — PulseChain Arbitrage Scanner v4.9.3

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

📘 **Full process manual / white paper:** [PDF edition](Arb-Me-Now_WhitePaper_v4.4.pdf) · [Markdown](WHITEPAPER.md)

## How to use

1. Open **[cryptales.github.io/Arb-Me-Now/](https://cryptales.github.io/Arb-Me-Now/)** — it scans automatically on load.
2. Choose your **start token**, enter your **trade size**, and set a min profit threshold.
3. Toggle venues on/off to narrow the search.
4. Click **Inspect** on any row to see both legs, pool addresses, reserves, and the exact integer calculation.
5. Tick **🔔 Alert on new profitable route** plus **Auto-refresh every 15 s** to get a sound + browser notification when a net-profitable route appears.
6. Use the **LibertySwap bridge** panel to check whether USDC or WETH on PulseChain is priced below its Ethereum equivalent.

---

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

`dashboard.html` and `trade-companion.html` are older files kept for reference only. Use `index.html`.

---

## Changelog

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
