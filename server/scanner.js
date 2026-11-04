#!/usr/bin/env node
/**
 * Arb-Me-Now v5.0 — Server Scanner + Telegram Alerts
 *
 * Runs the same scanner engine as the browser UI, checks every route for
 * profitability after gas, and messages you on Telegram when a net-positive
 * route appears.  You still decide when to send the actual trade.
 *
 * Usage:
 *   cp config.example.json config.json   # then fill in your values
 *   node scanner.js
 *
 * Requirements:  Node.js 18+ (fetch built in).  No other dependencies.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ─── Load config ──────────────────────────────────────────────────────────────
const cfgPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(cfgPath)) {
  console.error('config.json not found.  Copy config.example.json to config.json and fill in your values.');
  process.exit(1);
}
const CFG = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const {
  telegram_bot_token: BOT_TOKEN,   // from @BotFather
  telegram_chat_id:  CHAT_ID,      // your Telegram user/group ID
  rpc_urls          = ['https://rpc.pulsechain.com'],
  start_token       = 'WPLS',      // token to start routes from
  amount_in         = '1000',      // simulated trade size (human units, e.g. "1000" for 1000 WPLS)
  min_profit_bps    = 0,           // minimum gross profit in bps before alerting
  scan_interval_s   = 30,          // seconds between scans
  dedup_minutes     = 5,           // suppress repeat alerts for the same route
  v3_depth          = 4,           // tick intervals per V3 leg (1–8)
  do_triangular     = true,        // also scan triangular 3-hop routes
  csv_log           = true,        // append one "best route this scan" row to a CSV (even when negative)
  csv_path          = 'scan_log.csv', // CSV file: relative to server/ dir, or an absolute path
} = CFG;

const DRY = process.argv.includes('--dry'), ONCE = process.argv.includes('--once');
if (!DRY && (!BOT_TOKEN || BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE')) {
  console.error('Set telegram_bot_token in config.json.  Get one from @BotFather on Telegram.');
  process.exit(1);
}
if (!DRY && (!CHAT_ID || CHAT_ID === 'YOUR_CHAT_ID_HERE')) {
  console.error('Set telegram_chat_id in config.json.  Send a message to your bot, then visit: https://api.telegram.org/bot<TOKEN>/getUpdates');
  process.exit(1);
}

// ─── Load engine ──────────────────────────────────────────────────────────────
const ENGINE_PATH = path.join(__dirname, '..', 'engine.js');
if (!fs.existsSync(ENGINE_PATH)) {
  console.error('engine.js not found at ' + ENGINE_PATH + '.  Run scanner.js from the server/ directory, with engine.js one level up.');
  process.exit(1);
}
const E = require(ENGINE_PATH);
E.setRpcs(rpc_urls);
E.setV3DepthCap(Math.max(1, Math.min(8, v3_depth)));

// ─── Gas model (must match ui.js) ─────────────────────────────────────────────
const GAS_BASE = 210000, GAS_HOP_V2 = 140000, GAS_HOP_V3 = 230000;
function routeGas(legs) {
  return GAS_BASE + legs.reduce((g, l) => g + (l && l.pool && l.pool.kind === 'v3' ? GAS_HOP_V3 : GAS_HOP_V2), 0);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function toFloat(raw, dec) { return Number(raw) / 10 ** dec; }
function fmtUsd(v) {
  if (v == null || !isFinite(v)) return '—';
  return (Math.abs(v) >= 1 ? '$' + v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '$' + v.toPrecision(3));
}
function fmtPct(v) { return (v >= 0 ? '+' : '') + (v * 100).toFixed(3) + '%'; }
function fmtToken(raw, dec, sym) { return (Number(raw) / 10 ** dec).toFixed(4) + ' ' + sym; }
function routeKey(r) {
  if (r.kind === 'tri') return `tri:${r.startSym}>${r.midSymY}>${r.midSymZ}>${r.legA.pool.label}>${r.legB.pool.label}>${r.legC.pool.label}`;
  return `${r.startSym}>${E.symOf(r.otherAddr)}>${r.legA.pool.label}>${r.legB.pool.label}`;
}

// ─── CSV telemetry ────────────────────────────────────────────────────────────
// One row per scan: the single most-promising route (ranked by gross gap), even
// when it loses money after gas.  Lets you study near-misses over time.
const CSV_PATH = csv_log ? (path.isAbsolute(csv_path) ? csv_path : path.join(__dirname, csv_path)) : null;
const CSV_HEADER = [
  'timestamp', 'scan', 'block', 'gas_price_gwei', 'routes_evaluated', 'net_positive',
  'best_route', 'best_type', 'best_pools', 'mid_gap_pct',
  'opt_size_tok', 'opt_gross_usd', 'opt_bps', 'gas_units', 'gas_usd', 'opt_net_usd',
  'fixed_size_tok', 'fixed_gross_usd', 'fixed_net_usd',
].join(',');
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvNum(v, dp) { return (v == null || !isFinite(v)) ? '' : Number(v).toFixed(dp); }
function csvAppend(fields) {
  if (!CSV_PATH) return;
  try {
    if (!fs.existsSync(CSV_PATH) || fs.statSync(CSV_PATH).size === 0) fs.writeFileSync(CSV_PATH, CSV_HEADER + '\n');
    fs.appendFileSync(CSV_PATH, fields.map(csvCell).join(',') + '\n');
  } catch (e) { console.warn('[CSV] write failed:', e.message); }
}

// ─── Deduplication ────────────────────────────────────────────────────────────
const alertedAt = new Map(); // key → timestamp of last alert
function shouldAlert(key) {
  const last = alertedAt.get(key);
  if (last && Date.now() - last < dedup_minutes * 60 * 1000) return false;
  alertedAt.set(key, Date.now());
  return true;
}

// ─── Telegram send ────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (DRY) { console.log('  [dry run, not sent]\n' + text.replace(/<[^>]+>/g, '')); return; }
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
    });
    const j = await res.json();
    if (!j.ok) console.warn('[TG]', j.description);
  } catch (e) {
    console.warn('[TG] send failed:', e.message);
  }
}

// ─── Build alert message ──────────────────────────────────────────────────────
function buildMessage(r, dec, profUsd, gasUsd, netUsd, gasUnits) {
  const sym = r.startSym;
  const isTri = r.kind === 'tri';
  const route = isTri
    ? `${sym}→${r.midSymY}→${r.midSymZ}→${sym}`
    : `${sym}→${E.symOf(r.otherAddr)}→${sym}`;
  const legs = isTri
    ? `${r.legA.pool.label} → ${r.legB.pool.label} → ${r.legC.pool.label}`
    : `${r.legA.pool.label} → ${r.legB.pool.label}`;
  const profitTok = fmtToken(r.opt.profit, dec, sym);
  const bpsStr = r.bps != null ? ` (${r.bps.toFixed(1)} bps)` : '';
  const optSize = fmtToken(r.opt.amountIn, dec, sym);
  const gasStr = `~${Math.round(gasUnits / 1000)}k gas | ${fmtUsd(gasUsd)}`;
  const netStr = netUsd != null ? fmtUsd(netUsd) : '—';

  return [
    `🚨 <b>Arb-Me-Now: profitable route</b>`,
    ``,
    `<b>Route:</b> ${route}`,
    `<b>Pools:</b> ${legs}`,
    `<b>Mid gap:</b> ${fmtPct(r.midEdge)}`,
    ``,
    `<b>Optimal size:</b> ${optSize}`,
    `<b>Gross profit:</b> +${profitTok}${bpsStr} (${fmtUsd(profUsd)})`,
    `<b>Est. gas:</b> ${gasStr}`,
    `<b>Net after gas:</b> <b>${netStr}</b>  ← use Dry Run to confirm`,
    ``,
    `Open Trade Companion to Dry Run and Send:`,
    `https://cryptales.github.io/Arb-Me-Now/`,
    ``,
    `<i>This is an estimate. Always Dry Run before sending. Not financial advice.</i>`,
  ].join('\n');
}

// ─── Main scan loop ───────────────────────────────────────────────────────────
let scanCount = 0;
let cachedPools = null;

async function scan() {
  scanCount++;
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  try {
    // 1. Discover pools (fetches factory/router lists once; cached after first call)
    const enabled = { pulsex_v1: true, pulsex_v2: true, ninemm_v2: true, liberty_v3: true };
    if (!cachedPools || scanCount % 120 === 1) cachedPools = await E.discoverPools(enabled); // re-discover every ~120 scans
    const pools = cachedPools;
    if (!pools.length) throw new Error('No pools discovered');

    // 2. Fetch live state for all pools
    const dec = E.TOKENS[start_token]?.dec;
    if (dec == null) throw new Error('Unknown start_token: ' + start_token);
    const amountInRaw = E.parseUnits(amount_in, dec);
    const { block, pools: livePools } = await E.fetchPoolStates(pools, amountInRaw, E.TOKENS[start_token].addr);

    // 3. Fetch gas price and prices
    const gasPrice = await E.rpc('eth_gasPrice', []).then(v => BigInt(v)).catch(() => null);
    const wpls = E.wplsUsd(livePools);
    const usdS = E.tokenUsd(start_token, livePools, wpls);
    const gasUsdFn = (units) =>
      (gasPrice != null && wpls) ? Number(gasPrice * BigInt(units)) / 1e18 * wpls.price : null;

    // 4. Scan cycles
    const rows2 = E.scanCycles(livePools, start_token, amountInRaw);
    const rows3 = do_triangular ? E.scanTriangular(livePools, start_token, amountInRaw) : [];
    const allRows = [...rows2, ...rows3];

    // 5. Annotate every row — profit/gas/net at both the optimal and the fixed (user) size,
    //    plus the suspicious flag — so we can both alert AND log the best near-miss.
    const SUS_GAP = 0.5, DUST_USD = 25;
    const legCapUsd = (leg) => {
      const sym = E.symOf(leg.tokenIn); const px = E.tokenUsd(sym, livePools, wpls);
      return px == null ? null : toFloat(leg.maxIn, E.TOKENS[sym].dec) * px;
    };
    const ann = allRows.map(r => {
      if (!r.opt) return null;
      const isTri = r.kind === 'tri';
      const legList = isTri ? [r.legA, r.legB, r.legC] : [r.legA, r.legB];
      let suspicious = false;
      if (!isTri) { // suspicious check is 2-hop only; the triangular scanner already filters
        const capA = legCapUsd(r.legA), capB = legCapUsd(r.legB);
        const dust = (capA != null && capA < DUST_USD) || (capB != null && capB < DUST_USD);
        const wild = Math.abs(r.midEdge) > SUS_GAP;
        suspicious = dust || wild;
      }
      const optProfUsd = usdS != null ? toFloat(r.opt.profit, dec) * usdS : null;
      const bps = r.opt.amountIn > 0n ? Number(r.opt.profit * 1000000n / r.opt.amountIn) / 100 : null;
      r.bps = bps;
      const gasUnits   = routeGas(legList);
      const gasUsd     = gasUsdFn(gasUnits);
      const optNetUsd  = (optProfUsd != null && gasUsd != null) ? optProfUsd - gasUsd : null;
      const optSizeUsd = (usdS != null && r.opt && r.opt.amountIn != null) ? toFloat(r.opt.amountIn, dec) * usdS : null;
      const fixedProfUsd = (r.user && usdS != null) ? toFloat(r.user.profit, dec) * usdS : null;
      const fixedNetUsd  = (fixedProfUsd != null && gasUsd != null) ? fixedProfUsd - gasUsd : null;
      return { r, isTri, suspicious, optProfUsd, bps, gasUnits, gasUsd, optNetUsd, optSizeUsd, fixedProfUsd, fixedNetUsd };
    }).filter(Boolean);

    // 5a. Alert candidates: net-positive after gas, not suspicious, above min bps (behaviour unchanged).
    const candidates = ann.filter(a =>
      a.r.opt.profit > 0n && !a.suspicious
      && !(min_profit_bps > 0 && (a.bps == null || a.bps < min_profit_bps))
      && a.optNetUsd != null && a.optNetUsd > 0
    ).map(a => ({ r: a.r, profUsd: a.optProfUsd, gasUsd: a.gasUsd, netUsd: a.optNetUsd, gasUnits: a.gasUnits, bps: a.bps }));

    // 6. Log scan result
    const statusLine = `[${ts}] scan #${scanCount} block ${block}: `
      + `${allRows.length} routes evaluated, ${candidates.length} net-positive`;
    console.log(statusLine);

    // 6a. CSV telemetry — the single best route this scan (ranked by gross gap), even when it loses after gas.
    if (CSV_PATH) {
      const gasGwei = gasPrice != null ? Number(gasPrice) / 1e9 : null;
      // "Best" = the biggest real price gap among genuinely executable routes.
      // Non-suspicious 2-hop routes already cleared the engine's ≥$25 leg-liquidity (dust) check,
      // so they qualify at any profitability (these are the near-misses we want).  Triangular routes
      // skip that check upstream, so require a real optimal size (≥$25) to exclude illiquid mirages.
      let best = null;
      for (const a of ann) {
        if (a.suspicious) continue;
        if (a.isTri && !(a.optSizeUsd != null && a.optSizeUsd >= DUST_USD)) continue;
        if (!best || a.r.midEdge > best.r.midEdge) best = a;
      }
      if (best) {
        const r = best.r;
        const route = best.isTri ? `${r.startSym}>${r.midSymY}>${r.midSymZ}>${r.startSym}`
                                 : `${r.startSym}>${E.symOf(r.otherAddr)}>${r.startSym}`;
        const pools = best.isTri ? `${r.legA.pool.label} > ${r.legB.pool.label} > ${r.legC.pool.label}`
                                 : `${r.legA.pool.label} > ${r.legB.pool.label}`;
        const optSize   = (r.opt && r.opt.amountIn != null) ? toFloat(r.opt.amountIn, dec) : null;
        const fixedSize = r.user ? toFloat(r.user.amountIn, dec) : null;
        csvAppend([
          ts, scanCount, block, csvNum(gasGwei, 3), allRows.length, candidates.length,
          route, best.isTri ? 'tri' : '2hop', pools, csvNum(r.midEdge * 100, 4),
          csvNum(optSize, 4), csvNum(best.optProfUsd, 4), csvNum(best.bps, 2), best.gasUnits, csvNum(best.gasUsd, 4), csvNum(best.optNetUsd, 4),
          csvNum(fixedSize, 4), csvNum(best.fixedProfUsd, 4), csvNum(best.fixedNetUsd, 4),
        ]);
      } else {
        csvAppend([ts, scanCount, block, csvNum(gasGwei, 3), allRows.length, candidates.length,
          '', '', '', '', '', '', '', '', '', '', '', '', '']);
      }
    }

    // 7. Alert
    for (const { r, profUsd, gasUsd, netUsd, gasUnits } of candidates) {
      const key = routeKey(r);
      if (!shouldAlert(key)) {
        console.log(`  (dedup) ${key}`);
        continue;
      }
      const msg = buildMessage(r, dec, profUsd, gasUsd, netUsd, gasUnits);
      console.log(`  ALERT: ${key}  net ${fmtUsd(netUsd)}`);
      await sendTelegram(msg);
    }

  } catch (e) {
    console.error(`[${ts}] scan error:`, e.message);
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────
console.log(`Arb-Me-Now v5.0 server scanner`);
console.log(`  Start token : ${start_token}  |  Amount in: ${amount_in}`);
console.log(`  Scan interval: ${scan_interval_s}s  |  Dedup: ${dedup_minutes} min`);
console.log(`  V3 tick depth: ${v3_depth}  |  Triangular: ${do_triangular}`);
console.log(`  RPC: ${rpc_urls[0]}`);
console.log(DRY ? '  Telegram: DRY RUN (alerts printed here, nothing sent)' : '  Telegram: configured');
console.log(`Starting first scan...`);
console.log('');

if (ONCE) scan().then(() => process.exit(0));
else { scan(); setInterval(scan, scan_interval_s * 1000); }
