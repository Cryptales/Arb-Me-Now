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

# Keeper — automatic execution (`keeper.js`, guarded live pilot in v5.2.0)

`keeper.js` is a **separate** program from the scanner. Where the scanner alerts you and leaves the trade to you, the keeper watches the chain **per block**, and when a route clears your profit floor it simulates the exact `execute()` call against the live ArbExecutor contract and — only if you have explicitly armed the **guarded live pilot** — sends the transaction.

> **v5.2.0 — guarded live pilot.** The keeper can now send real signed `execute()` transactions, but **only** when three independent switches all line up (see the safety model below). It **defaults OFF** and, with the default config, behaves exactly like the read-only dry keeper. The pilot's purpose is to **measure realized-vs-simulated profit under real mempool competition** (backruns/sandwiches/lost races) — something a dry simulation cannot see — cheaply: PulseChain gas is ~$0.002–0.006 per attempt, so a lost race costs only gas. It is a measurement experiment, not a profit push.

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
| `max_gas_price_gwei` | Abort a send if live gas price exceeds this cap (`null` = no cap). |
| `tx_deadline_s` | Seconds added to `now` for the `execute()` deadline; the tx reverts if not mined in time (default 30). |
| `max_trades_per_day` | Stop sending after this many trades in a UTC day (default 25). |
| `keeper_enabled` | Global on/off for all sends. |

Single-flight: only one transaction is ever in flight at a time. Counters reset at UTC midnight.

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
| `realized_usd` | Realized **net** USD once a live tx is mined — gross profit from the `Executed` event minus gas (negative on an on-chain revert, where only gas is lost) |
| `error` | Any RPC/encode/send error surfaced for that cycle |
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

### Telegram

The keeper reuses the same `telegram_bot_token` / `telegram_chat_id` config, but notifies **only on actual executions** — a success (with tx hash + profit) or a failed send (with the decoded reason). It does not spam you on every simulate.

### Config

All keeper options live in `config.example.json` under the `_keeper_section` marker, each with an inline `_help` note. Copy them into your `config.json` and adjust. The key fields are `keeper_enabled`, `executor_address` (the public ArbExecutor contract — not your wallet), `poll_interval_ms`, `min_profit_usd`, `onchain_guard_frac`, and the kill switches above.

### Security notes (keeper)

- The private key is read **only** from the `KEEPER_PRIVATE_KEY` environment variable, **only** when the live pilot is armed (`live_enabled` + `--live`). There is **no file or config key source** (removed in v5.2.0). The key is never written to disk, logged, echoed (not even masked-with-length), or committed. `.gitignore` still covers `*.key`, `*.pem`, and `config.json` as defence-in-depth.
- On live start the signer's **public** derived address is verified against the executor's on-chain `keeper()`; a mismatch is a hard exit. Only that public address is ever printed.
- Simulate-only mode (the default — and the only mode unless all live preconditions are met) imports no signing library and holds no key — it is strictly read-only, exactly like the scanner and the dry keeper.
- `max_position_usd` bounds each trade's notional and `max_daily_loss_usd` halts sending for the UTC day once losses cross it, so even a worst case is bounded.
- Use a dedicated keeper wallet with a small balance so that even in a worst case the exposure is bounded to its gas balance.
