# Arb-Me-Now v5.0.1 — Server Scanner

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
