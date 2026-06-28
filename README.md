# ⚡ PulseChain Arb Dashboard — v4.1

**Free, open-source, browser-native arbitrage intelligence for the PulseChain DeFi ecosystem.**

No install · No server · No API keys · Just open and go.

---

## 📦 What's in this package

| File | Description |
|------|-------------|
| `dashboard.html` | Main arb dashboard — 6 DEXes, cross-DEX arb, tri-arb, wallet scanner, leaderboard, history, route calculator, dark/light theme |
| `trade-companion.html` | Step-by-step trade execution guide with live opportunities, direct DEX deep-links, slippage calculator, execution timer, and trade journal |
| `README.md` | This file |

---

## 🚀 Quick Start

1. Download all files to a folder
2. Double-click `dashboard.html` — done!
3. For trade execution help, open `trade-companion.html`

Both files work entirely offline except for the live blockchain data fetch.

---

## 📊 Dashboard Features

- **6 DEXes** — PulseX V1/V2, 9inch V2, 9mm V2, EazySwap, Velocimeter
- **Cross-DEX arb** — same pair priced differently across DEXes
- **Triangular arb** — 3-hop cycles within a single DEX
- **Leaderboard** — ranked by avg spread, sortable 4 ways
- **History chart** — canvas time-series per pair this session
- **Route calculator** — best 1-hop and 2-hop paths between any tokens
- **Multi-wallet scanner** — up to 5 wallets, side-by-side, unified arb opps
- **Alerts** — threshold slider, sound chimes, browser notifications
- **CSV export** — leaderboard history to spreadsheet
- **Dark / Light theme** — toggle at top right

## 💼 Trade Companion Features

- Live opportunity feed from all 6 DEXes
- Step-by-step execution instructions with **working DEX deep-links** (pre-fills input & output tokens)
- Slippage & price impact calculator for your trade size
- 60-second countdown execution timer
- Pre-trade checklist
- Trade journal with P&L tracking
- 5-win progress tracker
- Auto-refresh every 30 seconds

---

## 🔗 Supported DEXes

| DEX | Data Method | Swap Fee | TVL |
|-----|------------|----------|-----|
| PulseX V1 | Subgraph | 0.29% | ~$92M |
| PulseX V2 | Subgraph | 0.29% | ~$92M |
| 9inch V2 | On-chain RPC | 0.30% | ~$4.6M |
| 9mm V2 | On-chain RPC | 0.30% | ~$230K |
| EazySwap | On-chain RPC | 0.20% | ~$4.4M |
| Velocimeter | On-chain RPC | 0.20% | ~$79K |

---

## 🔒 Security

- **Read-only** — no wallet connection, no private keys, no transaction signing
- **No tracking** — zero analytics, no ads, no third-party scripts
- **No server** — all computation runs in your browser
- **Open source** — view the full source by opening in any text editor

---

## 🌐 How to Host & Share (Free)

### GitHub Pages (recommended — keeps it open source)
1. Create a free account at [github.com](https://github.com)
2. Click **New repository** → name it `pulsechain-arb-dashboard` → set to **Public**
3. Choose **MIT License**
4. Upload `dashboard.html`, `trade-companion.html`, and `README.md`
5. Go to **Settings → Pages → Source: main branch → Save**
6. Your dashboard goes live at:
   `https://yourusername.github.io/pulsechain-arb-dashboard/dashboard.html`

### Netlify (drag & drop, live in 30 seconds)
1. Go to [netlify.com](https://netlify.com)
2. Drag your project folder onto the deploy zone
3. Live instantly at a free `yourname.netlify.app` URL

### Share directly
Since the files are self-contained HTML, you can also just zip them up and post to:
- PulseChain Telegram groups
- Reddit r/Pulsechain
- PulseChain Discord servers

---

## 📝 Changelog

### v4.1 (June 2026)
- Fixed DEX deep-links to correctly pre-fill token pairs on PulseX
- Updated to current PulseX IPFS frontend URL
- Swap links now use actual contract addresses from subgraph data (not symbol lookup)
- WPLS correctly maps to native PLS (`ETH`) in swap URLs

### v4.0 (June 2026)
- Initial public release

---

## 🤝 Contributing

Pull requests welcome! Areas that could use community help:
- Adding more DEXes (Piteas, more Velocimeter pools)
- Mobile layout improvements
- Additional arb route strategies
- Auto-updating the PulseX IPFS hash when it changes

---

## ⚠️ Disclaimer

This tool is for informational and educational purposes only. It is not financial advice. Arbitrage opportunities may disappear before execution. Always verify prices on-chain. Never trade more than you can afford to lose.

---

*Built with ⚡ for the PulseChain community · MIT License · Free forever*
