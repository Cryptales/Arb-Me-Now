# ⚡ Arb-Me-Now — PulseChain Arbitrage Scanner v4.4

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
5. Use the **LibertySwap bridge** panel to check whether USDC or WETH on PulseChain is priced below its Ethereum equivalent.

---

## Limitations

- **2-pool round trips** and **triangular 3-hop routes** (S → Y → Z → S over three distinct pools) are checked. Triangular legs use the 10% reserve cap (v2) and the current tick interval (v3); only profitable triangular routes are listed.
- Gas is **not deducted** from the profit figures.
- LibertySwap V3 sizes are limited to the **current tick interval** (conservative).
- Bridge checks are **non-atomic** — the cross-chain price comparison excludes gas, slippage, and bridge-crossing time. Quotes are informational only.
- Nothing is signed or sent. This is analysis, not execution.

---

## Files

| File | Description |
|---|---|
| `index.html` | The complete scanner (single self-contained file — CSS, engine, and UI all inlined) |
| `README.md` | This file |

`dashboard.html` and `trade-companion.html` are older files kept for reference only. Use `index.html`.

---

## Changelog

### v4.4 (2026-11-01)
- Gas-adjusted net profit (live eth_gasPrice × 250k/350k gas).
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
