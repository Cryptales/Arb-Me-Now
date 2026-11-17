# Arb-Me-Now v5.1 — Server Scanner + Keeper

Runs the same scanner engine as the browser UI 24/7 on your own machine and sends a Telegram message whenever a route is profitable after gas. You still decide when and whether to trade.

## What it does

- Scans all PulseChain routes (2-pool cycles + optional triangular 3-hop) every 30 seconds (configurable).
- Checks every profitable route's net profit after gas, using the same gas model as the UI (210k base + 140k per V2 hop + 230k per V3 hop × live gas price).
- Sends one Telegram alert per route per 5 minutes (deduplication window is configurable).
- Logs every scan to the console.
- Logs one row per scan to a CSV (`scan_log.csv` by default) recording the single best route that scan — **even when it loses money after gas** — so you can study near-misses over time (new in v5.0.1).
- Needs no backend beyond the public PulseChain RPC and the Telegram Bot API. No wallet connection — read-only.

## Setup (one time)

### 1. Create a Telegram bot

1. Open Telegram and start a chat with **@BotFather**.
2. Send `/newbot` and follow the prompts (name + username).
3. Copy the bot token BotFather gives you (looks like `123456789:ABCdef...`).
4. Find your Telegram chat ID:
   - Start a chat with your new bot (search its username, hit Start).
   - Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser.
   - Send any message to your bot, reload the page, and look for `"chat":{"id":<NUMBER>}`. That number is your chat ID.

### 2. Configure the scanner

```bash
cd server
cp config.example.json config.json
```

Open `config.json` and fill in:
- `telegram_bot_token` — from BotFather
- `telegram_chat_id` — your chat ID (a number, positive for personal chats)

Optionally change `start_token`, `amount_in`, `scan_interval_s`, etc. All options are documented in `config.example.json`.

### 3. Run the scanner

```bash
# From the repo root:
node server/scanner.js

# Or from the server/ directory:
cd server && node scanner.js
```

Requires **Node.js 18 or higher** (check with `node --version`). No `npm install` needed — it uses only built-in modules and `engine.js` from the parent directory.

### 4. Test first (no Telegram needed)

```bash
node server/scanner.js --dry --once
```

`--dry` prints alerts to the terminal instead of sending them, and `--once` exits after one scan. You should see a line like `scan #1 block … : 200 routes evaluated, 0 net-positive`. Then run it without flags to start the continuous Telegram scanner.

## Keeping it running

The scanner needs to run on a machine that stays on. Options:

- **Your own PC / SuperComputer:** run it in a terminal. Use `screen` or `tmux` to keep it alive when you close the window (`screen -S arb node server/scanner.js`).
- **A cloud VPS:** copy the repo to a cheap VPS and run it there. A $4/month VPS is enough.
- **PM2 (process manager):** `npm install -g pm2 && pm2 start server/scanner.js --name arb-scanner`.

This machine (Abacus AI Agent) shuts down when idle and cannot host a persistent process.

## What to do when you get an alert

1. Open **https://cryptales.github.io/Arb-Me-Now/** on your phone or desktop.
2. Set your start token and trade size to match what the alert shows.
3. Click **Scan** to confirm the route is still there in a fresh block.
4. Open **Trade Companion → Inspect** on that row.
5. Click **Dry run** (an `eth_call`; nothing is signed). Check the net-after-gas figure — that is the number to trust.
6. If the dry run says "Would succeed" and the net profit is worth the risk, click **Build calldata** and **Connect & Send**, approve in your ZKX wallet, and act quickly (deadline: now + 600 s).

The alert's "Net after gas" is an estimate. The dry run's measured gas is the final word. Markets move fast — always re-scan right before sending.

## Scan log (CSV) — studying near-misses

Every scan appends one row to `scan_log.csv` (change the name or disable it with `csv_path` / `csv_log` in `config.json`). The row records the **single best route that scan — the biggest genuine price gap among executable routes — even when it loses money after gas**. This lets you answer questions like "how close did we come this week, and on which pairs?" before deciding whether automatic execution (v5.1) is worth building.

"Best" is ranked by the gross price gap (`mid_gap_pct`) among *executable* routes only: non-suspicious 2-hop routes (which already clear the engine's ≥$25 leg-liquidity floor) plus triangular routes whose optimal size is ≥$25. Illiquid dust mirages are excluded, so the log reflects real opportunities.

Columns:

| Column | Meaning |
|---|---|
| `timestamp`, `scan`, `block` | When the scan ran and which block it read |
| `gas_price_gwei` | Live gas price at scan time |
| `routes_evaluated` | Total routes checked this scan |
| `net_positive` | How many cleared the alert bar (net-positive after gas) |
| `best_route`, `best_type` | The best route (e.g. `WPLS>HEX>WPLS`) and `2hop` / `tri` |
| `best_pools` | The pools/venues it runs through |
| `mid_gap_pct` | Gross price gap of the best route, in % (the headline near-miss number) |
| `opt_size_tok` | Optimal trade size (start-token units). Near 0 means unprofitable at any real size |
| `opt_gross_usd`, `opt_bps` | Gross profit at optimal size, in USD and basis points (negative = a miss) |
| `gas_units`, `gas_usd` | Estimated gas for the route |
| `opt_net_usd` | Net after gas at optimal size — the alert metric (>0 would fire an alert) |
| `fixed_size_tok`, `fixed_gross_usd`, `fixed_net_usd` | The same route evaluated at your fixed `amount_in` size, for a consistent apples-to-apples series (blank if the route can't take that size) |

Load it in any spreadsheet or with pandas. The file is gitignored by default — it's your private data.

## Security notes

- `config.json` is in `.gitignore`. Never commit it.
- The bot token only allows sending messages to `telegram_chat_id`. It has no access to your wallet.
- The scanner only reads from the RPC and the Telegram API. It never signs transactions.

---

# Keeper — automatic execution (`keeper.js`, guarded live pilot + inclusion speed + MEV protection; bundle submission in v5.5.0)

`keeper.js` is a **separate** program from the scanner. Where the scanner alerts you and leaves the trade to you, the keeper watches the chain **per block**, and when a route clears your profit floor it simulates the exact `execute()` call against the live ArbExecutor contract and — only if you have explicitly armed the **guarded live pilot** — sends the transaction.

> **v5.2.0 — guarded live pilot.** The keeper can now send real signed `execute()` transactions, but **only** when three independent switches all line up (see the safety model below). It **defaults OFF** and, with the default config, behaves exactly like the read-only dry keeper. The pilot's purpose is to **measure realized-vs-simulated profit under real mempool competition** (backruns/sandwiches/lost races) — something a dry simulation cannot see — cheaply: PulseChain gas is ~$0.002–0.006 per attempt, so a lost race costs only gas. It is a measurement experiment, not a profit push.

> **v5.3.0 — inclusion speed + receipt accounting.** The first real live fire taught us two things: (1) our bottleneck is **inclusion speed** — the tx was computed at one block but not mined until **16 blocks later**, by which point the edge was gone and the on-chain guard correctly reverted (cost: ~$0.00005 gas, $0 capital); and (2) the keeper **failed to record the revert outcome** back into `keeper_log.csv` (the `realized_usd` and `error` columns were left blank). v5.3.0 fixes both: live txs now **bid priority gas** to land faster (with a gas-vs-edge guard so speed never eats the profit), every live fire now **reliably resolves its receipt** and writes realized P&L + outcome (no more blank columns), and **revert accounting** feeds the daily-loss kill-switch plus a **consecutive-revert circuit breaker** that pauses live firing when we keep losing the race.

> **v5.4.0 — MEV protection (private / bundled submission).** The priority-gas upgrade worked: the second live fire landed only **2 blocks late** (down from 16) — and **still reverted** despite a +$2.66 sim, this time after burning 218,843 gas fighting deep into the swaps before the on-chain `minProfit` guard caught it (realized −$0.0018, gas only). The lesson: **speed is no longer the bottleneck — public-mempool MEV is.** Our profitable `execute()` tx is visible in the public mempool the instant we broadcast it, and a faster/atomic competitor takes the edge before our swaps settle. v5.4.0 adds a configurable **submission layer** so the trade isn't broadcast to the whole world first. See **§ MEV protection — private / bundled submission** below.

> **v5.5.0 — bundle submission mode.** Private submission proved itself (never public, never front-run, $0 on misses) — but three thin-edge private fires in a row **expired un-included**, because BlockFerret only builds ~11% of PulseChain blocks. The fix is the **pro-searcher lane**: `submission_mode="bundle"` now fires an atomic `eth_sendBundle` **with a builder tip**, which is what buys inclusion from a cooperating builder. This needs an on-chain payment the old contract couldn't make, so v5.5.0 ships a **new ArbExecutor** with an `executeAndPay()` path that tips BlockFerret's (dynamic, live-fetched) `SearcherPaymentRouter` out of **realized profit, only after the on-chain `minProfit` guard passes** — a reverting trade never tips. The keeper reads `executor_address` from config, so cutting over to the new contract is a **config paste + hot-swap, no code edit**. See **§ MEV protection** below.

The whole design follows from one data finding (26,257 scans over ~9.4 days): profitable windows are rare (~0.23% of scans) and almost always last **exactly one block**. A 30 s scanner sees them after they have already closed. So the keeper reacts within a block and leans on an **on-chain profit guard** so a transaction that lands after the gap closes simply reverts (costing only gas) instead of trading at a loss.

### Safety model — read this before `--live`

The keeper is built so that the **default behaviour cannot send a transaction**, and so that arming the guarded live pilot takes **all of the following** — if any one is missing, the keeper stays read-only exactly like the dry keeper:

1. **`live_enabled: true` in `config.json`** — the v5.2.0 master switch. **Defaults to `false`** and is never auto-enabled. While it is `false`, `--live` is ignored and the keeper is strictly simulate-only.
2. **The `--live` CLI flag** — without it the keeper is in *simulate-only* mode: it detects, scans, ABI-encodes and `callStatic`-simulates every opportunity and logs it, but never signs or sends. `--dry` always wins: `--dry --live` stays simulate-only.
3. **A valid `KEEPER_PRIVATE_KEY` environment variable** — the dedicated keeper wallet's key, supplied **only** as an env var at launch. There is **no file or config key source** (removed in v5.2.0). If `live_enabled` + `--live` are set but the key is **missing or malformed**, the keeper **hard-exits** with a clear message rather than silently falling back.
4. **The key's derived address must equal the on-chain `keeper()`** — on live start the keeper derives the signer's public address from the key, reads the executor's `keeper()` view, and **refuses to run** (hard exit) unless they match (fail-fast; the contract would revert anyway). Only the **public** derived address is ever printed.

In addition, **`keeper_enabled: true`** remains a hard global send kill switch enforced at the guard.

**The private key is never written to disk, never logged or echoed (not even masked-with-length), and never committed.** The signing libraries are lazy-loaded only in `--live`/`--selftest`; the default simulate-only path holds no key and imports nothing.

**Guardrails & kill switches** (all in `config.json`, all enforced before every send):

| Setting | What it does |
|---|---|
| `min_profit_usd` / `min_net_usd` | Minimum **simulated net-after-gas USD** floor to act on a route (default $0.50). Only routes that clear sim with margin can fire. |
| `max_position_usd` | **v5.2.0** per-trade notional cap (default $400). Any fire whose optimal-size notional (start-token size × live USD price) exceeds it is skipped. |
| `max_daily_loss_usd` | **v5.2.0 kill-switch** (default $5.00). Tracks cumulative realized loss for the UTC day — gas spent on reverted/failed txs **plus** any trade that realized below its gas cost. Once crossed, live sending **halts for the rest of the day** (the keeper keeps scanning/simulating/logging). Resets at UTC midnight. |
| `onchain_guard_frac` | On-chain `minProfit` is set to this fraction of the simulated edge (default 0.9). The tx reverts unless ≥90% of the expected profit still exists at inclusion — the core guard against the one-block edge closing. |
| `gas_priority_mult` | **v5.3.0 inclusion speed** — bid this multiple of the live base gas price on live sends to land faster (default 1.25 = +25%). Capped at `max_gas_price_gwei`. 1.0 = no priority bid. |
| `max_gas_frac_of_edge` | **v5.3.0 gas-vs-edge guard** — never fire if the (priority-boosted) estimated gas cost exceeds this fraction of the simulated **gross** edge (default 0.5 = 50%). Keeps the priority bid from eating the profit. |
| `consecutive_revert_limit` | **v5.3.0 circuit breaker** — after this many on-chain reverts in a row, pause live sending (sim-only) until restart (default 5; 0 = off). A success resets the streak. |
| `receipt_wait_s` | **v5.3.0 receipt accounting** — seconds to poll for the tx receipt before logging `realized=pending` / `error=receipt_timeout` and re-checking on later cycles (default 90). |
| `max_gas_price_gwei` | Ceiling for the gas bid: abort a send if live base gas price exceeds this cap, and cap the priority bid at it (`null` = no cap). |
| `tx_deadline_s` | Seconds added to `now` for the `execute()` deadline in **public** mode; the tx reverts if not mined in time (default 30). |
| `submission_mode` | **v5.4.0 MEV protection** — `private` (default), `public`, or `bundle` (**fully functional in v5.5.0**). See § below. |
| `executor_address` | ArbExecutor contract the keeper targets (default `0xd5da79af…`). **Paste the v5.5.0 deployment here to enable bundle mode** — config paste + hot-swap, no code edit. |
| `private_rpc_url` | **v5.4.0** — BlockFerret private RPC for `private` mode (default `https://rpc.blockferret.win`). |
| `bundle_rpc_url` | **v5.4.0** — BlockFerret bundle endpoint for `bundle` mode (default `https://rpc.blockferret.win/builders`). |
| `private_tx_deadline_s` | **v5.4.0** — tight `execute()` deadline for `private`/`bundle` sends so a non-included tx expires harmlessly (default 30, range 5–1800). |
| `bundle_tip_bps` | **v5.5.0** — informational mirror of the deployed contract's on-chain `tipBps` (builder tip as bps of realized profit; default 1000 = 10%). The real tip is computed on-chain; keep this matching the deployment so the banner/notices read true (range 0–5000). |
| `bundle_blocks` | **v5.5.0** — how many consecutive target blocks each fire's bundle is submitted for (default 3, range 1–10). |
| `max_trades_per_day` | Stop sending after this many trades in a UTC day (default 25). |
| `keeper_enabled` | Global on/off for all sends. |

Single-flight: only one transaction is ever in flight at a time. Counters reset at UTC midnight (the consecutive-revert streak persists across midnight — a losing streak is a losing streak).

### How to go live safely

1. **Use a dedicated, low-balance keeper wallet** — never your main wallet. Fund it with only enough PLS for gas (each arb tx costs ~$0.0015). The owner's profit is paid to the owner by the contract regardless of which wallet sends.
2. **Authorize that wallet as the keeper on-chain.** The ArbExecutor restricts `execute()` to the owner or an appointed keeper. As the owner, call `setKeeper(<keeper_wallet_address>)` (via the app's Trade Companion → Deploy kit, or any wallet). You can revoke it any time with `setKeeper(0x0)`. **The keeper program never needs the owner key.**
3. **Install signing dependencies** (only needed for live sending — simulate-only needs nothing):
   ```bash
   cd server && npm install
   ```
   This pulls `@noble/curves` + `@noble/hashes` (pure-JS secp256k1). They are lazy-loaded; simulate-only mode never imports them.
4. **Enable the pilot in config** — set `"live_enabled": true` in your `config.json` (it defaults to `false`). This is the deliberate master switch; without it `--live` stays read-only.
5. **Provide the key via the environment variable ONLY** — there is no file or config key source. The key is never written to disk, logged, or committed:
   ```bash
   export KEEPER_PRIVATE_KEY=0x<your_dedicated_keeper_wallet_key>
   ```
   The derived address of this key **must equal the on-chain `keeper()`** you set in step 2, or the keeper refuses to start.
6. **Start the live keeper as a NEW, separate process** (do not touch the running `arb-scanner` / `arb-keeper-dry`). Pass the key inline so it only ever lives in that process's environment:
   ```bash
   KEEPER_PRIVATE_KEY=0x<dedicated_keeper_key> pm2 start keeper.js --name arb-keeper-live -- --live
   ```
   Or without pm2:
   ```bash
   KEEPER_PRIVATE_KEY=0x<dedicated_keeper_key> node keeper.js --live
   ```
   On startup the keeper prints its mode, the live-gate state (`live_enabled` / `--live` / key present → ARMED or read-only), and — if armed — the derived signer address and confirmation that it matches the on-chain `keeper()`. **Never** put the key in a file, a pm2 ecosystem file, shell history you commit, or `config.json`.

### Testing (no key, read-only)

All of these are safe — they never send:

```bash
node keeper.js --selftest        # offline crypto self-test: RLP vectors, keccak, sign -> ecrecover round-trip
node keeper.js --simtest         # live: discover pools, scan, ABI-encode + callStatic-simulate against the live contract
node keeper.js --dry --once      # live: one poll cycle against your real config, logs, sends nothing
node keeper.js --dry             # live: continuous per-block poll, simulate-only
```

### Keeper log (CSV)

The keeper writes its **own** CSV (`keeper_csv_path`, default `server/keeper_log.csv`) — completely separate from the scanner's `scan_log.csv`. Since **v5.1.1** it logs one row **every block** carrying the single best route it saw (with the same metric columns the scanner records), then the keeper's own decision columns, three shadow sizing-telemetry columns (**v5.1.2**), and five size-sweep columns (**v5.1.3**). 28 columns in all:

| Column | Meaning |
|---|---|
| `timestamp`, `block` | When the decision was made and the block it simulated at |
| `gas_price_gwei`, `routes_evaluated` | Live gas price and how many routes the engine evaluated that block |
| `best_route`, `best_type`, `best_pools` | The best route (e.g. `WPLS>pDAI>WPLS`), `2hop`/`tri`, and the pools/venues it runs through |
| `mid_gap_pct` | The best route's mid-price gap (%) — the raw price dislocation |
| `opt_size_tok`, `opt_gross_usd`, `opt_bps` | Engine optimal size (start token), gross profit (USD), and profit in basis points |
| `gas_units`, `gas_usd` | Estimated gas units and their USD cost |
| `opt_net_usd` | Engine net-after-gas profit at the optimal size — the metric the fire floor is applied to |
| `sim_decision` | `ok`, `none`/`skip`, or the decoded revert name (e.g. `NoProfit`, `Expired`) |
| `sim_net_usd` | Simulated net-after-gas profit in USD (when a candidate cleared the floor and was simulated) |
| `action` | `skip`, `sim` (simulate-only "would send"), or `live` (a real signed `execute()` tx was broadcast) |
| `tx_hash` | Transaction hash of the live send (blank otherwise) |
| `realized_usd` | Realized **net** USD once a live tx is mined — gross profit from the `Executed` event minus the actual gas spent (negative on an on-chain revert, where only gas is lost). **v5.3.0:** always populated for a live fire — the row is deferred until the receipt resolves; `pending` while a receipt is still outstanding (re-checked on later cycles) |
| `error` | For a live fire (**v5.3.0**): `success` on a mined profitable tx, `reverted_onchain;consec=N` on an on-chain revert (with the consecutive-revert count), or `receipt_timeout` while a receipt is still pending. Otherwise any RPC/encode/send error or guard reason (e.g. `guard:gas_vs_edge`) surfaced for that cycle |
| `shadow_cs_net_usd` | **v5.1.2** — on-chain `callStatic` net USD at the engine's optimal size (blank when out of band or the shadow call reverted) |
| `shadow_cs_prof_tok` | **v5.1.2** — raw `callStatic` profit in the start token |
| `shadow_ratio` | **v5.1.2** — `callStatic` profit ÷ engine profit; **>1 means the engine under-estimated** (if the shadow call reverted, the decoded reason appears here instead) |
| `sweep_1_5x_net_usd` | **v5.1.3** — true on-chain `callStatic` net USD after gas at **1.5×** the engine's optimal size (blank when out of band or that size reverts) |
| `sweep_2x_net_usd` | **v5.1.3** — same at **2×** the engine's optimal size |
| `sweep_4x_net_usd` | **v5.1.3** — same at **4×** the engine's optimal size |
| `sweep_best_mult` | **v5.1.3** — which multiple netted the most among `1x`/`1.5x`/`2x`/`4x` (`1x` = the v5.1.2 shadow at the engine size) |
| `sweep_best_net_usd` | **v5.1.3** — the best net USD across those sizes |

### Shadow sizing telemetry (v5.1.2)

The engine's optimal-size estimate (`opt_net_usd`) is deliberately conservative: `engine.js`'s adaptive V3 tick-depth reads only a couple of tick intervals when the reference `amount_in` is small, so at **large** optimal sizes during a real wide-gap event it can under-predict the true on-chain profit (one historical fire: engine `+$0.49` vs on-chain `callStatic` `+$2.81`, ~5.7×). Because the keeper only `callStatic`-simulates candidates that already clear the `$0.50` fire floor, a genuine wide-gap event where the engine computes a below-floor number would otherwise never be captured.

The shadow logger closes that gap. On **every** block, when the best route's engine `opt_net_usd` is within `shadow_band_usd` of the fire floor (`opt_net_usd >= min_profit_usd - shadow_band_usd`), it runs **one** extra read-only `callStatic` on that best route at the engine's optimal size and records the on-chain result alongside the engine's estimate. It is **SIMULATE-ONLY** — a pure `eth_call` from the owner address that can never send a transaction — and adds at most one extra RPC call per block, only when in-band. Toggle it with `shadow_enabled` (default on) and tune the near-miss window with `shadow_band_usd` (default `0.50`). The next real wide-gap fire is then self-documenting: `shadow_ratio > 1` quantifies exactly how much the engine under-sized it.

### Size-sweep shadow (v5.1.3)

The v5.1.2 shadow measures the on-chain result **at the engine's chosen size** — it validates the prediction but does not tell you whether a **larger** trade would net more. v5.1.3 adds that. On the same fire, the keeper runs three more read-only `callStatic`s on the best route at **1.5×, 2× and 4×** the engine's optimal `amountIn`, each built exactly as the executor expects (`packLeg` → `encodeExecute`) but with the on-chain `minProfit` forced to **1** so the guard can never revert the measurement — the call returns the *true* round-trip profit at that size regardless of whether it would clear the live floor. Net USD reuses the engine's gas estimate (gas barely changes with size). The results land in `sweep_1_5x_net_usd` / `sweep_2x_net_usd` / `sweep_4x_net_usd` (empty if that size reverts), with `sweep_best_mult` / `sweep_best_net_usd` naming the winning size (including `1x`, the v5.1.2 shadow at the engine size). It is **SIMULATE-ONLY** — pure `eth_call`s from the owner that can never send — and each sweep leg is isolated in its own `try`/`catch`, so a sweep failure can never break the cycle or the main trade path. At most three extra in-band RPC calls per fire.

### Inclusion speed + receipt accounting (v5.3.0)

The first real live fire (tx on `WPLS>pDAI>WPLS`) was computed at one block but not mined until **16 blocks later**; by then the edge had closed and the on-chain `minProfit` guard correctly reverted it — $0 capital moved, only ~$0.00005 gas lost. The safety worked perfectly, but it exposed two gaps that v5.3.0 closes:

- **Inclusion speed (the real bottleneck).** We arrive late and get beaten to the block. Live txs now bid **priority gas** — `gas_priority_mult` × the live base gas price (default 1.25×), capped at `max_gas_price_gwei` — so the tx is more attractive to validators and lands sooner. On PulseChain this costs fractions of a cent even at 1.5×. A **gas-vs-edge guard** (`max_gas_frac_of_edge`, default 0.5) refuses to fire if the boosted gas would exceed that fraction of the simulated gross edge, so bidding for speed can never eat the profit. The compute→send path is kept tight: the tx is pre-built from the simulated calldata and signed without redundant RPC round-trips.

- **Receipt accounting (the empty-column bug).** Previously the keeper wrote the live row **at send time** with `realized_usd` / `error` blank, then gave up if the receipt didn't arrive within the window — leaving those columns empty forever. Now the row is **deferred until the receipt resolves**: the keeper polls `eth_getTransactionReceipt` for up to `receipt_wait_s` (default 90 s), then writes the full row — on **success**, `realized_usd` = Executed-event gross profit − actual gas (`gasUsed × effectiveGasPrice`), `error` = `success`; on an **on-chain revert**, `realized_usd` = −(gas spent), `error` = `reverted_onchain;consec=N`. If the receipt still hasn't landed, it logs `realized=pending` / `error=receipt_timeout` and **re-checks on every later cycle** (up to 10 minutes), appending a resolution row when it lands — so a live fire is **never** left with blank outcome columns.

- **Revert accounting + circuit breaker.** Every revert's gas cost is added to the `max_daily_loss_usd` tally (so the $5 kill-switch is accurate), and a running **consecutive-revert** counter trips a circuit breaker at `consecutive_revert_limit` (default 5): live sending pauses (the keeper falls back to sim-only, keeps logging, and sends a loud Telegram warning) until it is restarted. A success resets the streak. This stops the keeper from burning gas indefinitely on an inclusion race it keeps losing.

### MEV protection — private / bundled submission (v5.4.0; bundle enabled v5.5.0)

The second live fire (`WPLS>WETH>PLSX>WPLS`, sim +$2.66) landed only **2 blocks late** thanks to the v5.3.0 priority bid — yet it **still reverted**, burning 218,843 gas fighting deep into the swaps before the on-chain `minProfit` guard caught it (realized −$0.0018, gas only). Inclusion speed was fixed; the edge still vanished before our swaps settled. The remaining leak is **public-mempool MEV**: the moment we broadcast an `execute()` tx to the public RPC, every searcher can see it and a faster or atomic competitor front-runs the arb. v5.4.0 adds a configurable **submission layer** that controls *how* the signed raw tx reaches the chain.

PulseChain has **no Flashbots service**; the functional equivalent is **[BlockFerret](https://blockferret.win)** (by Switch.win), an ethical "no-sandwich" builder. Three modes, selected by `submission_mode`:

- **`private` (default, recommended).** The signed tx is sent to BlockFerret's private RPC (`private_rpc_url`, default `https://rpc.blockferret.win`) via standard `eth_sendRawTransaction`. It is held in a **private pool and kept OUT of the public mempool** until a BlockFerret-built block includes it — so public-mempool searchers never see it and cannot front-run it. **No auth, no payment, no enrollment** — this is the simplest, lowest-risk win and directly addresses the measured failure. **Fully functional.**
- **`public`.** The old v5.3.0 behaviour — broadcast to the public RPC (`rpc_urls[0]`) mempool. Widest/fastest inclusion coverage, but fully exposed to front-running. **Fully functional** (kept for comparison / fallback).
- **`bundle` (v5.5.0, fully functional — the pro-searcher lane).** Atomic `eth_sendBundle` to BlockFerret's builder endpoint (`bundle_rpc_url`, default `https://rpc.blockferret.win/builders`) **with an on-chain builder tip**. Why: three thin-edge `private` fires in a row expired un-included (BlockFerret builds only ~11% of blocks), and the way to buy inclusion from a cooperating builder is to pay it. v5.5.0 ships a **new ArbExecutor** (`executeAndPay()`) that, **after** the on-chain `minProfit` guard passes, unwraps part of the realized WPLS profit and pays BlockFerret's **SearcherPaymentRouter** a tip (`tipBps`, split 60% validator / 40% builder) — a reverting trade **never** tips. Per fire the keeper fetches the router address (signed `blockferret_getSearcherTerms`) and per-block context (target block, parent hash, validator recipient, from `/v1/builder-context`) **live — nothing is hardcoded** — builds and signs the `executeAndPay()` raw tx, and submits it as a bundle for the next `bundle_blocks` target blocks, authenticated with the `FLASHBOTS_IDENTITY_KEY`-signed `X-Flashbots-Signature` header (env-only). A non-included bundle **expires harmlessly at $0**, exactly like private. **Requires:** (1) the v5.5.0 contract deployed and its address in `executor_address`, and (2) `FLASHBOTS_IDENTITY_KEY` in the env — missing it while live falls back to `private` with a warning.

**Honest trade-offs (why `private` is not a free lunch):**

- **Coverage, not every block.** BlockFerret only builds the blocks its validators are scheduled to propose — a **minority of PulseChain blocks** (via the Vouch relay, on the order of ~10%). A private tx therefore may **wait** for a BlockFerret-built block, and ordinary private txs can take **many minutes** on average to include. For a one-block arb edge, that means **many private sends will simply never land** — which is fine, because of the next point.
- **Tight deadline so a stale tx can't land.** `private`/`bundle` sends use `private_tx_deadline_s` (default **30 s**, deliberately tight) for the on-chain `execute()` deadline instead of `tx_deadline_s`. If the tx isn't included almost immediately, it **expires and reverts (gas only)** rather than landing minutes later after the edge is long gone. The keeper detects this, logs `error=expired_not_included;private`, and moves on.
- **No automatic fallback to public.** We do **not** silently re-broadcast a non-included private tx to the public mempool — that would re-expose it to the exact front-running we're avoiding. A private tx that misses its window is abandoned (expired), not leaked.
- **The thesis:** *fewer trades that are never front-run beats many trades that get picked off.* v5.4.0 trades some inclusion coverage for front-run immunity, and every guardrail (on-chain `minProfit`, priority gas bid, gas-vs-edge guard, daily-loss kill-switch, consecutive-revert circuit breaker, receipt accounting) stays fully in force in **all** modes.

> **Not yet exercised against a real on-chain send.** The private submission path is implemented and offline-verified (endpoint routing by mode, banner, deadline, notices), but at the time of this release **no real private tx has been mined** — the operator hot-swaps the live keeper after review. Treat the first few live private fires as the real measurement.
>
> **v5.5.0 bundle path — wired per the verified BlockFerret spec, but NOT exercised live.** The `executeAndPay()` contract compiles clean and passes its tests (21/21), and the keeper's bundle path (live router/context fetch, identity signing, `eth_sendBundle`, expiry handling) is built to the verified `SearcherPaymentRouter` mechanism — but it has **not** been run against the live BlockFerret `/builders` endpoint or a deployed v5.5.0 contract (no deploy, no real send in this release). Treat the first live bundle fires as the real measurement. `private` and `public` remain fully functional.

### Telegram

The keeper reuses the same `telegram_bot_token` / `telegram_chat_id` config, but notifies **only on actual executions**. **v5.3.0:** the notice reports the final **outcome** — a `SENT` notice (with the gas bid), then a `SUCCESS` notice (realized net $, gross − gas) or a `REVERTED` notice (gas lost + the consecutive-revert count, plus a `CIRCUIT BREAKER TRIPPED` alert if the streak hits the limit), or a `pending` notice if the receipt is slow. **v5.4.0:** the `SENT` notice now names the **submission mode** (`private` / `public`) and adds a 🔒 *out of public mempool* tag for private sends, and a non-included private tx emits an `expired` notice. It does not spam you on every simulate.

### Config

All keeper options live in `config.example.json` under the `_keeper_section` marker, each with an inline `_help` note. Copy them into your `config.json` and adjust. The key fields are `keeper_enabled`, `executor_address` (the public ArbExecutor contract — not your wallet), `poll_interval_ms`, `min_profit_usd`, `onchain_guard_frac`, and the kill switches above.

### Security notes (keeper)

- The private key is read **only** from the `KEEPER_PRIVATE_KEY` environment variable, **only** when the live pilot is armed (`live_enabled` + `--live`). There is **no file or config key source** (removed in v5.2.0). The key is never written to disk, logged, echoed (not even masked-with-length), or committed. `.gitignore` still covers `*.key`, `*.pem`, and `config.json` as defence-in-depth.
- On live start the signer's **public** derived address is verified against the executor's on-chain `keeper()`; a mismatch is a hard exit. Only that public address is ever printed.
- Simulate-only mode (the default — and the only mode unless all live preconditions are met) imports no signing library and holds no key — it is strictly read-only, exactly like the scanner and the dry keeper.
- `max_position_usd` bounds each trade's notional and `max_daily_loss_usd` halts sending for the UTC day once losses cross it, so even a worst case is bounded.
- Use a dedicated keeper wallet with a small balance so that even in a worst case the exposure is bounded to its gas balance.
