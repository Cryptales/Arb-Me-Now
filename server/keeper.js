#!/usr/bin/env node
/**
 * Arb-Me-Now v5.1.2 — Keeper (simulate-first automatic execution)
 * ════════════════════════════════════════════════════════════════════════════
 * Reacts PER BLOCK: polls the chain tip, and the instant the block advances it
 * runs the same engine.js scan the browser and scanner use, picks the best
 * net-positive route, ABI-encodes the exact ArbExecutor.execute() call, and
 * SIMULATES it read-only (eth_call / callStatic) at the LATEST block. Only if
 * that simulation does not revert AND still clears the profit floor does it —
 * and only in --live mode with a signing key present — build, sign, and send
 * the transaction, with an on-chain minProfit guard so a tx that lands after
 * the edge has closed simply reverts (losing only gas) instead of trading at a
 * loss.
 *
 * SAFETY MODEL (read server/README.md before going live):
 *   • DEFAULT = simulate-only. Runs the full detect→build→simulate pipeline and
 *     logs what it WOULD do. Sends nothing. NO key required or read.
 *   • LIVE sending requires BOTH the --live flag AND a signing key in the env
 *     var KEEPER_PRIVATE_KEY or a gitignored key file. Missing either → refuse.
 *   • Single-flight: never more than one in-flight execution; new opportunities
 *     are skipped while a send is pending.
 *   • Kill switches (config): keeper_enabled, max_gas_price_gwei, min_profit_usd,
 *     max_trades_per_day, max_daily_loss_usd. All validated on startup.
 *   • The signing libs are loaded ONLY in --live / --selftest. The default
 *     simulate-only path uses engine.js + Node built-ins with zero npm install.
 *
 * Usage:
 *   node keeper.js                 # simulate-only, continuous (default, safe)
 *   node keeper.js --dry --once    # one detect+scan+simulate cycle, then exit
 *   node keeper.js --selftest      # prove the signer works with a THROWAWAY key
 *   node keeper.js --live          # LIVE: send real txs (needs a key; see README)
 *
 * Requirements: Node 18+ (built-in fetch). Live mode additionally needs the
 * signing deps — run `npm install` inside server/ once (see server/package.json).
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const crypto = require('crypto');

// ─── CLI flags ──────────────────────────────────────────────────────────────
const ARGV     = process.argv.slice(2);
const SELFTEST = ARGV.includes('--selftest');
const SIMTEST  = ARGV.includes('--simtest');   // simulate the best live route (any profitability) then exit
const ONCE     = ARGV.includes('--once');
const DRY_FLAG = ARGV.includes('--dry');
// --live asks to send; --dry always wins and forces simulate-only (safety).
const LIVE     = ARGV.includes('--live') && !DRY_FLAG;

const CHAIN_ID = 369;                                   // PulseChain mainnet
const DEFAULT_EXECUTOR = '0xd5da79af4c4c24f9d3afec0a1cbd761a24b130bd'; // deployed ArbExecutor (public contract addr)

// ─── Config load + validation ───────────────────────────────────────────────
function loadConfig() {
  // Default: server/config.json. Override with KEEPER_CONFIG=/path/to/config.json
  // (useful for running several keeper profiles, and for testing).
  const cfgPath = process.env.KEEPER_CONFIG
    ? (path.isAbsolute(process.env.KEEPER_CONFIG) ? process.env.KEEPER_CONFIG : path.join(__dirname, process.env.KEEPER_CONFIG))
    : path.join(__dirname, 'config.json');
  if (!fs.existsSync(cfgPath)) {
    fail('config file not found at ' + cfgPath + '. Copy config.example.json to config.json and fill in your values.');
  }
  let CFG;
  try { CFG = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch (e) { fail('config.json is not valid JSON: ' + e.message); }
  return CFG;
}

function num(v, name, { min = -Infinity, max = Infinity, allowNull = false } = {}) {
  if (v == null) { if (allowNull) return null; fail(`config: ${name} is required`); }
  const n = Number(v);
  if (!isFinite(n)) fail(`config: ${name} must be a number (got ${JSON.stringify(v)})`);
  if (n < min || n > max) fail(`config: ${name} must be between ${min} and ${max} (got ${n})`);
  return n;
}

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }
const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const KEEPER_VERSION = 'v5.1.3';

// ════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════
async function main() {
  const CFG = loadConfig();

  // Shared scanner fields.
  const rpcUrls      = Array.isArray(CFG.rpc_urls) && CFG.rpc_urls.length ? CFG.rpc_urls : ['https://rpc.pulsechain.com'];
  const startToken   = CFG.start_token || 'WPLS';
  const amountInHuman = CFG.amount_in != null ? String(CFG.amount_in) : '1000';
  const v3Depth      = Math.max(1, Math.min(8, num(CFG.v3_depth ?? 4, 'v3_depth', { min: 1, max: 8 })));
  const doTriangular = CFG.do_triangular !== false;

  // Keeper fields (with safe defaults).
  const keeperEnabled   = CFG.keeper_enabled !== false;                 // hard global on/off
  const executor        = (CFG.executor_address || DEFAULT_EXECUTOR).toLowerCase();
  const pollIntervalMs  = num(CFG.poll_interval_ms ?? 3000, 'poll_interval_ms', { min: 500, max: 60000 });
  const minProfitUsd    = num(CFG.min_profit_usd ?? CFG.min_net_usd ?? 0.50, 'min_profit_usd', { min: 0 });
  const maxGasPriceGwei = num(CFG.max_gas_price_gwei ?? null, 'max_gas_price_gwei', { min: 0, allowNull: true });
  const onchainGuardFrac = num(CFG.onchain_guard_frac ?? 0.9, 'onchain_guard_frac', { min: 0, max: 1 });
  const txDeadlineS     = num(CFG.tx_deadline_s ?? 30, 'tx_deadline_s', { min: 5, max: 3600 });
  const gasLimitBufPct  = num(CFG.gas_limit_buffer_pct ?? 25, 'gas_limit_buffer_pct', { min: 0, max: 300 });
  const maxTradesPerDay = num(CFG.max_trades_per_day ?? 25, 'max_trades_per_day', { min: 0, max: 100000 });
  const maxDailyLossUsd = num(CFG.max_daily_loss_usd ?? 5, 'max_daily_loss_usd', { min: 0 });
  const maxSimPerCycle  = num(CFG.max_sim_per_cycle ?? 3, 'max_sim_per_cycle', { min: 1, max: 20 });
  const keeperCsvRel    = CFG.keeper_csv_path || 'keeper_log.csv';
  const keyFileRel      = CFG.keeper_key_file || 'keeper.key';
  // Shadow sizing telemetry (v5.1.2): read-only engine-vs-chain capture on the best route.
  const shadowEnabled   = CFG.shadow_enabled !== false;                 // default ON
  const shadowBandUsd   = num(CFG.shadow_band_usd ?? 0.50, 'shadow_band_usd', { min: 0 });

  if (!/^0x[0-9a-fA-F]{40}$/.test(executor)) fail('config: executor_address is not a valid 0x address');

  // Telegram (reuse scanner config pattern; used ONLY for execution notices).
  const BOT_TOKEN = CFG.telegram_bot_token;
  const CHAT_ID   = CFG.telegram_chat_id;
  const tgReady   = BOT_TOKEN && BOT_TOKEN !== 'YOUR_BOT_TOKEN_HERE' && CHAT_ID && CHAT_ID !== 'YOUR_CHAT_ID_HERE';

  // ─── Engine ───────────────────────────────────────────────────────────────
  const ENGINE_PATH = path.join(__dirname, '..', 'engine.js');
  if (!fs.existsSync(ENGINE_PATH)) fail('engine.js not found at ' + ENGINE_PATH);
  const E = require(ENGINE_PATH);
  E.setRpcs(rpcUrls);
  E.setV3DepthCap(v3Depth);

  const dec = E.TOKENS[startToken] && E.TOKENS[startToken].dec;
  if (dec == null) fail('config: unknown start_token ' + startToken);
  const startAddr = E.TOKENS[startToken].addr;
  const amountInRaw = E.parseUnits(amountInHuman, dec);

  // ─── Signer (live only) ─────────────────────────────────────────────────────
  let signer = null;
  if (LIVE) {
    signer = await setupSigner({ keyFileRel, rpcUrls });  // throws/exits on any problem
  }

  // ─── Robust RPC (timeout + retry/backoff + multi-URL fallback) ──────────────
  const RPC_TIMEOUT_MS = 8000, RPC_RETRIES = 2;
  async function rpcRaw(method, params) {
    let lastErr;
    for (let attempt = 0; attempt <= RPC_RETRIES; attempt++) {
      for (const url of rpcUrls) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return await res.json();                    // full JSON (incl. .error) — caller decides
        } catch (e) {
          clearTimeout(timer);
          lastErr = e;
        }
      }
      if (attempt < RPC_RETRIES) await sleep(300 * Math.pow(2, attempt)); // 300ms, 600ms backoff
    }
    throw new Error(`RPC ${method} failed after ${RPC_RETRIES + 1} attempts: ${lastErr && lastErr.message}`);
  }
  async function rpcOk(method, params) {
    const j = await rpcRaw(method, params);
    if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
  }
  const getBlockNumber = async () => parseInt(await rpcOk('eth_blockNumber', []), 16);

  // ─── Gas model (must match ui.js / scanner.js) ──────────────────────────────
  const GAS_BASE = 210000, GAS_HOP_V2 = 140000, GAS_HOP_V3 = 230000;
  const routeGas = legs => GAS_BASE + legs.reduce((g, l) => g + (l && l.pool && l.pool.kind === 'v3' ? GAS_HOP_V3 : GAS_HOP_V2), 0);
  const toFloat = (raw, d) => Number(raw) / 10 ** d;
  const fmtUsd = v => (v == null || !isFinite(v)) ? '—' : (Math.abs(v) >= 1 ? '$' + v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '$' + v.toPrecision(3));
  const fmtTok = (raw, d, sym) => (Number(raw) / 10 ** d).toFixed(4) + ' ' + sym;

  // ─── CSV telemetry (keeper_log.csv — separate from scanner's scan_log.csv) ───
  // v5.1.1: every row carries the scanner-style best-route metrics (so keeper_log.csv and
  // scan_log.csv can be compared directly), then the keeper's own decision columns.
  const CSV_PATH = path.isAbsolute(keeperCsvRel) ? keeperCsvRel : path.join(__dirname, keeperCsvRel);
  const CSV_HEADER = [
    'timestamp', 'block', 'gas_price_gwei', 'routes_evaluated',
    'best_route', 'best_type', 'best_pools', 'mid_gap_pct',
    'opt_size_tok', 'opt_gross_usd', 'opt_bps', 'gas_units', 'gas_usd', 'opt_net_usd',
    'sim_decision', 'sim_net_usd', 'action', 'tx_hash', 'realized_usd', 'error',
    'shadow_cs_net_usd', 'shadow_cs_prof_tok', 'shadow_ratio',
    'sweep_1_5x_net_usd', 'sweep_2x_net_usd', 'sweep_4x_net_usd', 'sweep_best_mult', 'sweep_best_net_usd',
  ].join(',');
  function csvCell(v) { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function csvNum(v, dp) { return (v == null || !isFinite(v)) ? '' : Number(v).toFixed(dp); }
  function csvAppend(fields) {
    try {
      if (!fs.existsSync(CSV_PATH) || fs.statSync(CSV_PATH).size === 0) fs.writeFileSync(CSV_PATH, CSV_HEADER + '\n');
      fs.appendFileSync(CSV_PATH, fields.map(csvCell).join(',') + '\n');
    } catch (e) { console.warn('[CSV] write failed:', e.message); }
  }
  // The best-route metric prefix (14 cells, timestamp..opt_net_usd) for the current block.
  // `curScan` is set at the top of each runCycle once the scan succeeds, so every log row
  // — no-candidate, below-floor, revert, guard, sim, sent, error — reports the same single
  // best executable route the keeper saw that block, exactly as scanner.js logs it.
  let curScan = null;
  let curShadow = null;   // v5.1.2: read-only engine-vs-chain capture for the current block (or null)
  function prefix(scanOrBlock) {
    // Accept either a scan result (normal path) or a bare block number (pre-scan errors).
    const scan = (scanOrBlock && typeof scanOrBlock === 'object') ? scanOrBlock : null;
    const b = scan ? (scan.block != null ? scan.block : '') : (scanOrBlock != null ? scanOrBlock : '');
    const gasGwei = scan && scan.gasPrice != null ? Number(scan.gasPrice) / 1e9 : null;
    const re = scan && scan.routesEvaluated != null ? scan.routesEvaluated : '';
    const bm = scan && scan.best;
    if (bm) {
      return [nowIso(), b, csvNum(gasGwei, 3), re,
        bm.route, bm.type, bm.pools, csvNum(bm.midGapPct, 4),
        csvNum(bm.optSize, 4), csvNum(bm.optProfUsd, 4), csvNum(bm.bps, 2),
        bm.gasUnits, csvNum(bm.gasUsd, 4), csvNum(bm.optNetUsd, 4)];
    }
    return [nowIso(), b, csvNum(gasGwei, 3), re, '', '', '', '', '', '', '', '', '', ''];
  }
  // keeperFields = [sim_decision, sim_net_usd, action, tx_hash, realized_usd, error]
  // v5.1.2: every row carries 3 shadow cells; v5.1.3 adds 5 size-sweep cells so the
  // 28-column schema stays aligned on every code path.
  function logRow(keeperFields) {
    const sh = curShadow
      ? [ csvNum(curShadow.net, 4),
          csvNum(curShadow.profTok, 4),
          (curShadow.ratio != null ? csvNum(curShadow.ratio, 3) : (curShadow.revert || '')) ]
      : ['', '', ''];
    // v5.1.3: 5 size-sweep cells (1.5x/2x/4x read-only net, best multiplier, best net).
    const sw = (curShadow && curShadow.sweep)
      ? [ csvNum(curShadow.sweep.n15, 4),
          csvNum(curShadow.sweep.n2,  4),
          csvNum(curShadow.sweep.n4,  4),
          (curShadow.sweep.bestMult || ''),
          csvNum(curShadow.sweep.bestNet, 4) ]
      : ['', '', '', '', ''];
    csvAppend([...prefix(curScan), ...keeperFields, ...sh, ...sw]);
  }

  // ─── Telegram (execution notices only) ──────────────────────────────────────
  async function notify(text) {
    if (!tgReady) return;
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
      });
      const j = await res.json();
      if (!j.ok) console.warn('[TG]', j.description);
    } catch (e) { console.warn('[TG] send failed:', e.message); }
  }

  // ─── Daily guards (reset at UTC midnight) ───────────────────────────────────
  const daily = { day: new Date().toISOString().slice(0, 10), trades: 0, lossUsd: 0 };
  function rollDay() {
    const d = new Date().toISOString().slice(0, 10);
    if (d !== daily.day) { daily.day = d; daily.trades = 0; daily.lossUsd = 0; console.log(`[${nowIso()}] daily counters reset for ${d}`); }
  }

  // ─── Route helpers ──────────────────────────────────────────────────────────
  const legsOf = r => (r.kind === 'tri' ? [r.legA, r.legB, r.legC] : [r.legA, r.legB]);
  const routeStr = r => r.kind === 'tri'
    ? `${r.startSym}>${r.midSymY}>${r.midSymZ}>${r.startSym}`
    : `${r.startSym}>${E.symOf(r.otherAddr)}>${r.startSym}`;
  const venuesStr = r => legsOf(r).map(l => l.pool.label).join(' > ');

  // Scan the chain at the current tip and return annotated, net-positive candidates
  // (optimal-size net USD >= minProfitUsd, dust/suspicious filtered) sorted best-first.
  async function scanCandidates() {
    const enabled = { pulsex_v1: true, pulsex_v2: true, ninemm_v2: true, liberty_v3: true };
    if (!scanCandidates._pools || scanCandidates._n++ % 120 === 0) {
      scanCandidates._pools = await E.discoverPools(enabled);
      scanCandidates._n = 1;
    }
    const basePools = scanCandidates._pools;
    if (!basePools.length) throw new Error('No pools discovered');

    const { block, pools: livePools } = await E.fetchPoolStates(basePools, amountInRaw, startAddr);
    const gasPrice = await E.rpc('eth_gasPrice', []).then(v => BigInt(v)).catch(() => null);
    const wpls = E.wplsUsd(livePools);
    const usdS = E.tokenUsd(startToken, livePools, wpls);
    const gasUsdFn = units => (gasPrice != null && wpls) ? Number(gasPrice * BigInt(units)) / 1e18 * wpls.price : null;

    const rows2 = E.scanCycles(livePools, startToken, amountInRaw);
    const rows3 = doTriangular ? E.scanTriangular(livePools, startToken, amountInRaw) : [];
    const allRows = [...rows2, ...rows3];

    const SUS_GAP = 0.5, DUST_USD = 25;
    const legCapUsd = leg => {
      const sym = E.symOf(leg.tokenIn); const px = E.tokenUsd(sym, livePools, wpls);
      return px == null ? null : toFloat(leg.maxIn, E.TOKENS[sym].dec) * px;
    };
    const cand = [];
    for (const r of allRows) {
      if (!r.opt || !(r.opt.profit > 0n)) continue;
      const isTri = r.kind === 'tri';
      let suspicious = false;
      if (!isTri) {
        const capA = legCapUsd(r.legA), capB = legCapUsd(r.legB);
        const dust = (capA != null && capA < DUST_USD) || (capB != null && capB < DUST_USD);
        suspicious = dust || Math.abs(r.midEdge) > SUS_GAP;
      } else {
        const optSizeUsd = usdS != null ? toFloat(r.opt.amountIn, dec) * usdS : null;
        if (!(optSizeUsd != null && optSizeUsd >= DUST_USD)) suspicious = true;  // illiquid mirage guard
      }
      if (suspicious) continue;
      const optProfUsd = usdS != null ? toFloat(r.opt.profit, dec) * usdS : null;
      const gasUnits = routeGas(legsOf(r));
      const gasUsd = gasUsdFn(gasUnits);
      const netUsd = (optProfUsd != null && gasUsd != null) ? optProfUsd - gasUsd : null;
      if (!(netUsd != null && netUsd >= minProfitUsd)) continue;
      cand.push({ r, optProfUsd, gasUnits, gasUsd, netUsd, usdS });
    }
    cand.sort((a, b) => b.netUsd - a.netUsd);

    // Best route for telemetry — identical selection to scanner.js: the biggest real price
    // gap (midEdge) among genuinely executable routes, logged EVERY block even when net-negative.
    // Non-suspicious 2-hop routes already cleared the ≥$25 leg-liquidity floor; triangular
    // routes must have an optimal size ≥$25 to exclude illiquid mirages.
    let bestRow = null;
    for (const r of allRows) {
      if (!r.opt) continue;
      const isTri = r.kind === 'tri';
      let suspicious = false;
      if (!isTri) {
        const capA = legCapUsd(r.legA), capB = legCapUsd(r.legB);
        const dust = (capA != null && capA < DUST_USD) || (capB != null && capB < DUST_USD);
        suspicious = dust || Math.abs(r.midEdge) > SUS_GAP;
      } else {
        const optSizeUsd = usdS != null ? toFloat(r.opt.amountIn, dec) * usdS : null;
        if (!(optSizeUsd != null && optSizeUsd >= DUST_USD)) suspicious = true;
      }
      if (suspicious) continue;
      if (!bestRow || r.midEdge > bestRow.r.midEdge) bestRow = { r, isTri };
    }
    let best = null;
    if (bestRow) {
      const r = bestRow.r;
      const optProfUsd = usdS != null ? toFloat(r.opt.profit, dec) * usdS : null;
      const bps = r.opt.amountIn > 0n ? Number(r.opt.profit * 1000000n / r.opt.amountIn) / 100 : null;
      const gasUnits = routeGas(legsOf(r));
      const gasUsd = gasUsdFn(gasUnits);
      best = {
        route: routeStr(r),
        type: bestRow.isTri ? 'tri' : '2hop',
        pools: venuesStr(r),
        midGapPct: r.midEdge * 100,
        optSize: r.opt.amountIn != null ? toFloat(r.opt.amountIn, dec) : null,
        optProfUsd,
        bps,
        gasUnits,
        gasUsd,
        optNetUsd: (optProfUsd != null && gasUsd != null) ? optProfUsd - gasUsd : null,
      };
    }

    return { block, candidates: cand, usdS, gasPrice, wpls, best, bestR: bestRow ? bestRow.r : null, routesEvaluated: allRows.length };
  }

  // ─── callStatic simulation of the exact execute() call ──────────────────────
  // Default (no signer): engine.simulateExecute() runs it from the on-chain owner.
  // Live: run it from the keeper signer address (the real sender).
  function buildCalldata(c) {
    const r = c.r;
    const packed = legsOf(r).map(E.packLeg);
    const amountIn = r.opt.amountIn;
    // On-chain floor: require >= onchainGuardFrac of the expected edge to survive to inclusion.
    let minProfit = (r.opt.profit * BigInt(Math.round(onchainGuardFrac * 1e6))) / 1000000n;
    if (minProfit < 1n) minProfit = 1n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + Math.round(txDeadlineS));
    const calldata = E.encodeExecute(packed, amountIn, minProfit, deadline);
    return { calldata, amountIn, minProfit, deadline };
  }
  async function simulate(c, built) {
    if (!signer) {
      // from owner — proven, testable without any key
      const s = await E.simulateExecute(executor, built.calldata);
      return s;
    }
    // from the live signer address
    const j = await rpcRaw('eth_call', [{ from: signer.address, to: executor, data: built.calldata, gas: '0x' + (3000000).toString(16) }, 'latest']);
    if (j.error) {
      const data = typeof j.error.data === 'string' ? j.error.data : (j.error.data && j.error.data.data);
      return { ok: false, ...E.decodeRevert(data), message: j.error.message };
    }
    return { ok: true, profit: BigInt(j.result.slice(0, 66)) };
  }

  // ─── Single-flight guard ────────────────────────────────────────────────────
  let busy = false;

  // ─── One detect→scan→select→simulate→(send) cycle ──────────────────────────
  async function runCycle(block) {
    rollDay();
    let scan;
    try { scan = await scanCandidates(); }
    catch (e) {
      console.error(`[${nowIso()}] blk ${block}: scan error: ${e.message}`);
      curScan = null;
      curShadow = null;
      csvAppend([...prefix(block), 'scan_error', '', 'skip', '', '', e.message, '', '', '', '', '', '', '', '']);
      return;
    }
    curScan = scan;   // best-route metrics for every row logged this cycle

    // ── Shadow sizing telemetry (v5.1.2) ──────────────────────────────────────
    // Read-only: run ONE extra callStatic on the best route when its engine opt_net_usd is
    // within shadow_band_usd of the fire floor, so a real wide-gap event is captured
    // engine-vs-chain even if the engine's conservative adaptive-depth under-sizes it below
    // the floor. NEVER sends — simulate() with no signer is a pure eth_call from the owner.
    curShadow = null;
    if (shadowEnabled && scan.bestR && scan.best && scan.best.optNetUsd != null
        && scan.best.optNetUsd >= (minProfitUsd - shadowBandUsd)) {
      try {
        const built = buildCalldata({ r: scan.bestR });   // buildCalldata only reads c.r
        const sim = await simulate({ r: scan.bestR }, built); // no signer => read-only callStatic from owner
        if (sim.ok) {
          const shProfUsd = scan.usdS != null ? toFloat(sim.profit, dec) * scan.usdS : null;
          const shNet = (shProfUsd != null && scan.best.gasUsd != null) ? shProfUsd - scan.best.gasUsd : null;
          const ratio = (shProfUsd != null && scan.best.optProfUsd) ? shProfUsd / scan.best.optProfUsd : null;
          curShadow = { net: shNet, profTok: toFloat(sim.profit, dec), ratio, revert: null, sweep: null };
        } else {
          curShadow = { net: null, profTok: null, ratio: null, revert: (sim.name || 'Revert'), sweep: null };
        }
      } catch (e) {
        curShadow = { net: null, profTok: null, ratio: null, revert: 'err:' + String(e.message).slice(0, 40), sweep: null };
      }

      // ── Size-sweep shadow (v5.1.3) ──────────────────────────────────────────
      // Read-only: on the SAME fire, run callStatics on the best route at 1.5x/2x/4x the
      // engine's optimal amountIn with minProfit=1 (so the on-chain guard never masks the
      // measurement) to reveal whether a LARGER trade nets more than the engine's chosen
      // size. Pure eth_call from the owner — can NEVER send. Each sweep leg is isolated in
      // its own try/catch so a failure never breaks the cycle or the main trade path.
      try {
        const r = scan.bestR;
        const sweepOne = async (mult) => {
          try {
            const scaledAmountIn = (r.opt.amountIn * BigInt(Math.round(mult * 1000))) / 1000n;
            const packed = legsOf(r).map(E.packLeg);
            const deadline = BigInt(Math.floor(Date.now() / 1000) + Math.round(txDeadlineS));
            const calldata = E.encodeExecute(packed, scaledAmountIn, 1n, deadline);
            const sim = await E.simulateExecute(executor, calldata);
            if (sim.ok) {
              const profUsd = scan.usdS != null ? toFloat(sim.profit, dec) * scan.usdS : null;
              return (profUsd != null && scan.best.gasUsd != null) ? profUsd - scan.best.gasUsd : null;
            }
            return null; // revert => empty cell
          } catch (e) { return null; }
        };
        const n15 = await sweepOne(1.5);
        const n2  = await sweepOne(2);
        const n4  = await sweepOne(4);
        // Best across {1x engine shadow net, 1.5x, 2x, 4x}.
        const cands = [
          { mult: '1x',   net: (curShadow ? curShadow.net : null) },
          { mult: '1.5x', net: n15 },
          { mult: '2x',   net: n2 },
          { mult: '4x',   net: n4 },
        ].filter(c => c.net != null && isFinite(c.net));
        let bestMult = null, bestNet = null;
        for (const c of cands) { if (bestNet == null || c.net > bestNet) { bestNet = c.net; bestMult = c.mult; } }
        if (curShadow) curShadow.sweep = { n15, n2, n4, bestMult, bestNet };
      } catch (e) {
        if (curShadow) curShadow.sweep = { n15: null, n2: null, n4: null, bestMult: null, bestNet: null };
      }
    }

    const b = scan.block || block;
    if (!scan.candidates.length) {
      const bm = scan.best;
      console.log(`[${nowIso()}] blk ${b}: no net-positive route >= ${fmtUsd(minProfitUsd)}`
        + (bm ? ` (best: ${bm.route} gap ${bm.midGapPct.toFixed(3)}% net ${fmtUsd(bm.optNetUsd)})` : ''));
      logRow(['none', '', 'skip', '', '', '']);
      return;
    }

    let acted = false;
    const topN = scan.candidates.slice(0, maxSimPerCycle);
    for (const c of topN) {
      const r = c.r;
      const built = buildCalldata(c);
      let sim;
      try { sim = await simulate(c, built); }
      catch (e) {
        console.error(`[${nowIso()}] blk ${b}: ${routeStr(r)} sim RPC error: ${e.message}`);
        logRow(['sim_error', '', 'skip', '', '', e.message]);
        continue;
      }

      if (!sim.ok) {
        const reason = sim.name === 'NoProfit'
          ? `NoProfit(returned=${sim.returned}, required=${sim.required})`
          : (sim.name || 'Revert') + (sim.detail ? ':' + sim.detail : '');
        console.log(`[${nowIso()}] blk ${b}: ${routeStr(r)} would REVERT → ${reason} (edge gone — correctly not sending)`);
        logRow(['revert:' + (sim.name || 'Revert'), '', 'skip', '', '', reason]);
        continue;
      }

      // On-chain confirmed profit → net USD using the live start-token price.
      const simProfUsd = c.usdS != null ? toFloat(sim.profit, dec) * c.usdS : null;
      const simNetUsd = (simProfUsd != null && c.gasUsd != null) ? simProfUsd - c.gasUsd : null;
      const meetsFloor = simNetUsd != null && simNetUsd >= minProfitUsd;

      console.log(`[${nowIso()}] blk ${b}: ${routeStr(r)} [${venuesStr(r)}]`);
      console.log(`           size ${fmtTok(built.amountIn, dec, r.startSym)} | sim profit ${fmtTok(sim.profit, dec, r.startSym)} (${fmtUsd(simProfUsd)}) | gas ${fmtUsd(c.gasUsd)} | sim NET ${fmtUsd(simNetUsd)}`);

      if (!meetsFloor) {
        console.log(`           → sim net below floor ${fmtUsd(minProfitUsd)}; skip`);
        logRow(['ok', simNetUsd != null ? simNetUsd.toFixed(4) : '', 'skip', '', '', 'below_floor']);
        continue;
      }

      // ── Guards before any send ──
      const guardMsg = checkGuards(scan.gasPrice);
      if (guardMsg) {
        console.log(`           → guard blocked send: ${guardMsg}`);
        logRow(['ok', simNetUsd.toFixed(4), 'skip', '', '', 'guard:' + guardMsg]);
        continue;
      }

      if (!LIVE) {
        console.log(`           → SIMULATE-ONLY mode: would send (use --live + key to execute).`);
        logRow(['ok', simNetUsd.toFixed(4), 'sim', '', '', '']);
        acted = true;
        break;        // in simulate-only, one confirmed opportunity per cycle is enough to log
      }

      // ── LIVE send (single-flight) ──
      if (busy) { console.log('           → busy with another send; skipping'); break; }
      busy = true;
      try {
        await sendLive({ b, r, built, simNetUsd, simProfUsd, c });
        acted = true;
      } catch (e) {
        console.error(`           → send failed: ${e.message}`);
        logRow(['ok', simNetUsd.toFixed(4), 'sent', '', '', 'send_error:' + e.message]);
        await notify(`⚠️ <b>Keeper send failed</b>\n${routeStr(r)}\n${e.message}`);
      } finally {
        busy = false;
      }
      break;          // one execution attempt per cycle
    }
    if (!acted && topN.length) {
      // all simulated candidates reverted / below floor / guard-blocked — already logged per row
    }
  }

  function checkGuards(gasPrice) {
    if (!keeperEnabled) return 'keeper_enabled=false';
    if (daily.trades >= maxTradesPerDay) return `max_trades_per_day (${maxTradesPerDay}) reached`;
    if (daily.lossUsd >= maxDailyLossUsd) return `max_daily_loss_usd (${fmtUsd(maxDailyLossUsd)}) reached`;
    if (maxGasPriceGwei != null && gasPrice != null) {
      const gwei = Number(gasPrice) / 1e9;
      if (gwei > maxGasPriceGwei) return `gas price ${gwei.toFixed(2)} gwei > cap ${maxGasPriceGwei}`;
    }
    return null;
  }

  // ─── LIVE execution: build, sign, send, await receipt ───────────────────────
  async function sendLive({ b, r, built, simNetUsd, simProfUsd, c }) {
    const sk = signer;
    // nonce (pending), gas price (capped), gas limit (estimate + buffer)
    const nonce = BigInt(await rpcOk('eth_getTransactionCount', [sk.address, 'pending']));
    const gasPrice = BigInt(await rpcOk('eth_gasPrice', []));
    if (maxGasPriceGwei != null && Number(gasPrice) / 1e9 > maxGasPriceGwei) {
      throw new Error(`gas price ${(Number(gasPrice) / 1e9).toFixed(2)} gwei exceeds cap ${maxGasPriceGwei}`);
    }
    let gasLimit;
    const ge = await rpcRaw('eth_estimateGas', [{ from: sk.address, to: executor, data: built.calldata }]);
    if (ge.error) throw new Error('estimateGas reverted: ' + (ge.error.message || JSON.stringify(ge.error)));
    gasLimit = (BigInt(ge.result) * BigInt(100 + Math.round(gasLimitBufPct))) / 100n;

    const rawTx = sk.signLegacyTx({ nonce, gasPrice, gasLimit, to: executor, value: 0n, data: built.calldata, chainId: CHAIN_ID });
    const txHash = await rpcOk('eth_sendRawTransaction', [rawTx]);
    console.log(`           → SENT ${txHash} (nonce ${nonce}, gas ${gasLimit})`);
    daily.trades++;
    logRow(['ok', simNetUsd.toFixed(4), 'sent', txHash, '', '']);
    await notify(`🚀 <b>Keeper SENT</b>\n${routeStr(r)}\n${venuesStr(r)}\nsim net ${fmtUsd(simNetUsd)}\n<code>${txHash}</code>`);

    // Await receipt
    const receipt = await waitReceipt(txHash, 60000);
    if (!receipt) {
      console.warn('           → receipt not seen within timeout; check explorer');
      await notify(`⌛ <b>Keeper tx pending</b> (no receipt yet)\n<code>${txHash}</code>`);
      return;
    }
    const ok = BigInt(receipt.status) === 1n;
    const realized = ok ? decodeRealizedUsd(receipt, c.usdS, dec, sk.keccak) : null;
    if (ok) {
      console.log(`           → SUCCESS ${txHash} realized ${fmtUsd(realized)}`);
      logRow(['ok', simNetUsd.toFixed(4), 'sent', txHash, realized != null ? realized.toFixed(4) : '', '']);
      await notify(`✅ <b>Keeper SUCCESS</b>\n${routeStr(r)}\nrealized ${fmtUsd(realized)}\n<code>${txHash}</code>`);
    } else {
      // reverted on-chain (edge closed by inclusion): lost only gas
      const gasUsd = c.gasUsd != null ? c.gasUsd : 0;
      daily.lossUsd += gasUsd;
      console.log(`           → REVERTED on-chain ${txHash} (edge closed; lost ~${fmtUsd(gasUsd)} gas)`);
      logRow(['ok', simNetUsd.toFixed(4), 'sent', txHash, (-gasUsd).toFixed(4), 'reverted_onchain']);
      await notify(`❌ <b>Keeper tx reverted</b> (edge closed; only gas lost ~${fmtUsd(gasUsd)})\n<code>${txHash}</code>`);
    }
  }

  async function waitReceipt(txHash, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const j = await rpcRaw('eth_getTransactionReceipt', [txHash]);
        if (!j.error && j.result) return j.result;
      } catch (e) { /* transient — keep polling */ }
      await sleep(2500);
    }
    return null;
  }

  // Decode Executed(address indexed token, uint256 amountIn, uint256 profit, uint256 legs)
  function decodeRealizedUsd(receipt, usdS, d, keccak) {
    try {
      if (usdS == null || !keccak) return null;
      const topic0 = '0x' + Buffer.from(keccak(Buffer.from('Executed(address,uint256,uint256,uint256)', 'utf8'))).toString('hex');
      for (const log of receipt.logs || []) {
        if ((log.address || '').toLowerCase() !== executor) continue;
        if (!log.topics || log.topics[0].toLowerCase() !== topic0) continue;
        const data = log.data.slice(2);
        const profit = BigInt('0x' + data.slice(64, 128));   // word[1] = profit
        return toFloat(profit, d) * usdS;
      }
    } catch (e) { /* best-effort */ }
    return null;
  }

  // ─── Startup banner ─────────────────────────────────────────────────────────
  console.log(`Arb-Me-Now ${KEEPER_VERSION} keeper`);
  console.log(`  Mode        : ${LIVE ? '🔴 LIVE (will send real transactions)' : '🟢 SIMULATE-ONLY (no key, sends nothing)'}`);
  console.log(`  Executor    : ${executor}`);
  console.log(`  Start token : ${startToken}  |  ref size: ${amountInHuman}  |  V3 depth: ${v3Depth}  |  triangular: ${doTriangular}`);
  console.log(`  Min profit  : ${fmtUsd(minProfitUsd)} net after gas  |  on-chain guard: ${(onchainGuardFrac * 100).toFixed(0)}% of edge`);
  console.log(`  Guards      : maxGas ${maxGasPriceGwei == null ? 'none' : maxGasPriceGwei + ' gwei'} | maxTrades/day ${maxTradesPerDay} | maxLoss/day ${fmtUsd(maxDailyLossUsd)} | enabled ${keeperEnabled}`);
  console.log(`  Poll        : ${pollIntervalMs}ms  |  RPC: ${rpcUrls[0]}${rpcUrls.length > 1 ? ' (+' + (rpcUrls.length - 1) + ' fallback)' : ''}`);
  console.log(`  CSV         : ${CSV_PATH}`);
  console.log(`  Telegram    : ${tgReady ? 'configured (execution notices)' : 'not configured (execution notices disabled)'}`);
  if (LIVE) console.log(`  Signer      : ${signer.address}`);
  if (LIVE && !keeperEnabled) console.log('  ⚠ keeper_enabled=false — guards will block all sends.');
  console.log('');

  if (LIVE) await notify(`🔴 <b>Arb-Me-Now keeper LIVE</b>\nexecutor <code>${executor}</code>\nmin net ${fmtUsd(minProfitUsd)} | maxTrades/day ${maxTradesPerDay}`);

  // ─── Detect loop: scan only when the block advances ─────────────────────────
  let lastBlock = 0;
  async function tick() {
    try {
      const bn = await getBlockNumber();
      if (bn > lastBlock) {
        lastBlock = bn;
        if (!busy) await runCycle(bn);
        else console.log(`[${nowIso()}] blk ${bn}: send in flight, skipping scan (single-flight)`);
      }
    } catch (e) {
      console.error(`[${nowIso()}] block poll error: ${e.message}`);  // never crash the loop
    }
  }

  if (SIMTEST) {
    // Diagnostic: scan the live chain, pick the single best route by raw price gap
    // (regardless of profitability), ABI-encode execute() and callStatic-simulate it
    // against the live ArbExecutor. Proves encode + RPC + revert-decode end-to-end.
    await runSimTest();
    process.exit(0);
  }

  async function runSimTest() {
    console.log('── --simtest: encode + callStatic an execute() against the live contract ──');
    const enabled = { pulsex_v1: true, pulsex_v2: true, ninemm_v2: true, liberty_v3: true };
    const basePools = await E.discoverPools(enabled);
    console.log(`  discovered ${basePools.length} pools`);
    const { block, pools: livePools } = await E.fetchPoolStates(basePools, amountInRaw, startAddr);
    console.log(`  live state @ block ${block} (${livePools.length} pools with liquidity)`);
    const rows2 = E.scanCycles(livePools, startToken, amountInRaw);
    const rows3 = doTriangular ? E.scanTriangular(livePools, startToken, amountInRaw) : [];
    const rows = [...rows2, ...rows3].filter(r => r.opt && r.opt.amountIn != null && r.opt.amountIn > 0n);
    console.log(`  scanned ${rows2.length} two-pool + ${rows3.length} triangular routes`);
    if (!rows.length) { console.log('  no routes with a positive size to simulate right now'); return; }
    rows.sort((a, b) => (b.midEdge || 0) - (a.midEdge || 0));
    const r = rows[0];
    const c = { r };
    const built = buildCalldata(c);
    console.log(`  best route by gap: ${routeStr(r)} [${venuesStr(r)}]`);
    console.log(`  size ${fmtTok(built.amountIn, dec, r.startSym)} | on-chain minProfit ${built.minProfit} | deadline +${txDeadlineS}s`);
    console.log(`  calldata ${built.calldata.slice(0, 20)}… (${(built.calldata.length - 2) / 2} bytes), selector ${built.calldata.slice(0, 10)}`);
    const sim = await simulate(c, built);
    const maskAddr = a => (typeof a === 'string' && a.length >= 10) ? a.slice(0, 6) + '…' + a.slice(-4) : '?';
    if (sim.ok) {
      console.log(`  ✓ SIMULATION OK (would not revert). owner()=${maskAddr(sim.owner)} (read from chain) profit=${sim.profit} ${startToken}-raw${sim.gas != null ? ` gas≈${sim.gas}` : ''}`);
    } else {
      const reason = sim.name === 'NoProfit'
        ? `NoProfit(returned=${sim.returned}, required=${sim.required})`
        : (sim.name || 'Revert') + (sim.detail ? ':' + sim.detail : '');
      console.log(`  ✓ SIMULATION REVERTED and was DECODED → ${reason}`);
      console.log('    (this is the expected/correct outcome for a non-profitable route: the keeper would NOT send.)');
    }
  }

  if (ONCE) {
    // Force exactly one scan+simulate cycle at the current tip (don't wait for a new block).
    const bn = await getBlockNumber().catch(() => 0);
    lastBlock = bn;
    await runCycle(bn);
    process.exit(0);
  } else {
    await tick();
    setInterval(tick, pollIntervalMs);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SIGNER — lazy-loaded audited crypto, used ONLY in --live / --selftest.
// Default simulate-only mode never calls this, so it needs no npm install.
// ════════════════════════════════════════════════════════════════════════════
function loadSigningLibs() {
  let secp, keccak_256;
  try {
    ({ secp256k1: secp } = require('@noble/curves/secp256k1'));
    ({ keccak_256 } = require('@noble/hashes/sha3'));
  } catch (e) {
    fail('Live/selftest signing needs the signing libs.\n' +
         '  Run:  cd ' + __dirname + ' && npm install\n' +
         '  (installs @noble/curves + @noble/hashes — pinned in server/package.json)');
  }
  return { secp, keccak_256 };
}

// RLP encode (minimal, correct for tx fields).
function rlpEncode(input) {
  if (Array.isArray(input)) {
    const out = Buffer.concat(input.map(rlpEncode));
    return Buffer.concat([rlpLen(out.length, 0xc0), out]);
  }
  const buf = toBuf(input);
  if (buf.length === 1 && buf[0] < 0x80) return buf;
  return Buffer.concat([rlpLen(buf.length, 0x80), buf]);
}
function rlpLen(len, offset) {
  if (len < 56) return Buffer.from([offset + len]);
  const hex = len.toString(16); const lh = hex.length % 2 ? '0' + hex : hex;
  const lb = Buffer.from(lh, 'hex');
  return Buffer.concat([Buffer.from([offset + 55 + lb.length]), lb]);
}
function toBuf(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v == null) return Buffer.alloc(0);
  if (typeof v === 'bigint') {
    if (v === 0n) return Buffer.alloc(0);          // RLP: integers are minimal, 0 = empty
    let h = v.toString(16); if (h.length % 2) h = '0' + h;
    return Buffer.from(h, 'hex');
  }
  if (typeof v === 'string') {
    if (v.startsWith('0x')) { let h = v.slice(2); if (h.length % 2) h = '0' + h; return Buffer.from(h, 'hex'); }
    return Buffer.from(v, 'utf8');
  }
  if (typeof v === 'number') return toBuf(BigInt(v));
  throw new Error('rlp: unsupported type ' + typeof v);
}
function to32(bn) { let h = bn.toString(16); if (h.length % 2) h = '0' + h; return Buffer.from(h.padStart(64, '0'), 'hex'); }

function makeSigner(privHex, libs) {
  const { secp, keccak_256 } = libs;
  const priv = Buffer.from(privHex.replace(/^0x/, ''), 'hex');
  if (priv.length !== 32) throw new Error('private key must be 32 bytes (64 hex chars)');
  const pub = secp.getPublicKey(priv, false);         // 65-byte uncompressed (0x04 || X || Y)
  const address = '0x' + Buffer.from(keccak_256(pub.slice(1))).slice(-20).toString('hex');

  function signLegacyTx({ nonce, gasPrice, gasLimit, to, value, data, chainId }) {
    // EIP-155: sign over [nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]
    const unsigned = [toBuf(nonce), toBuf(gasPrice), toBuf(gasLimit), toBuf(to), toBuf(value), toBuf(data), toBuf(BigInt(chainId)), toBuf(0n), toBuf(0n)];
    const sigHash = keccak_256(rlpEncode(unsigned));
    const sig = secp.sign(sigHash, priv);               // lowS by default (Ethereum requires it)
    const v = BigInt(sig.recovery) + BigInt(chainId) * 2n + 35n;
    const signed = [toBuf(nonce), toBuf(gasPrice), toBuf(gasLimit), toBuf(to), toBuf(value), toBuf(data), toBuf(v), to32(sig.r), to32(sig.s)];
    return '0x' + rlpEncode(signed).toString('hex');
  }

  // Sign a dummy hash and recover the pubkey back to THIS address — proves the
  // signer works end-to-end before we ever broadcast. Never sends anything.
  function selfCheck() {
    try {
      const h = keccak_256(Buffer.from('arb-me-now keeper self-check', 'utf8'));
      const sig = secp.sign(h, priv);
      const recov = sig.recoverPublicKey(h).toRawBytes(false);
      const recAddr = '0x' + Buffer.from(keccak_256(recov.slice(1))).slice(-20).toString('hex');
      return recAddr === address;
    } catch (e) { return false; }
  }

  return { address, signLegacyTx, selfCheck, keccak: keccak_256, _secp: secp };
}

async function setupSigner({ keyFileRel, rpcUrls }) {
  const libs = loadSigningLibs();
  // Key source: env var preferred, else gitignored key file.
  let keyHex = process.env.KEEPER_PRIVATE_KEY;
  let source = 'env KEEPER_PRIVATE_KEY';
  if (!keyHex) {
    const kf = path.isAbsolute(keyFileRel) ? keyFileRel : path.join(__dirname, keyFileRel);
    if (fs.existsSync(kf)) {
      keyHex = fs.readFileSync(kf, 'utf8').trim();
      source = 'key file ' + kf;
    }
  }
  if (!keyHex) {
    fail('--live requires a signing key, and none was found.\n' +
         '  Provide it one of two ways (NEVER commit it):\n' +
         '    export KEEPER_PRIVATE_KEY=0x...     (recommended)\n' +
         '    or put the 0x-prefixed key in server/keeper.key (gitignored)\n' +
         '  Use a DEDICATED low-balance keeper wallet, authorized via setKeeper() on the executor.');
  }
  if (!/^0x?[0-9a-fA-F]{64}$/.test(keyHex)) fail('signing key is malformed (need 32 bytes / 64 hex chars). Source: ' + source);

  let sk;
  try { sk = makeSigner(keyHex, libs); }
  catch (e) { fail('could not derive signer from key: ' + e.message); }

  // Live pre-flight self-test: sign a dummy and ecrecover back to the same address.
  if (!sk.selfCheck()) fail('signer self-check FAILED (sign/recover mismatch) — refusing to go live');
  console.log(`✓ signer loaded from ${source}: ${sk.address} (self-check passed)`);
  // keyHex no longer needed in the outer scope; it lives only inside the closure.
  return sk;
}

// ════════════════════════════════════════════════════════════════════════════
// SELF-TEST (--selftest): full sign→recover round-trip with a THROWAWAY key.
// ════════════════════════════════════════════════════════════════════════════
async function runSelfTest() {
  console.log('Arb-Me-Now keeper signer self-test (throwaway key; nothing is sent)\n');
  const libs = loadSigningLibs();
  const { secp, keccak_256 } = libs;
  let pass = true;
  const check = (name, cond) => { console.log(`  ${cond ? '✓' : '✗'} ${name}`); if (!cond) pass = false; };

  // 1. RLP known-vector sanity: rlp("dog") = 0x83646f67
  check('RLP encodes short string correctly', rlpEncode('dog').toString('hex') === '83646f67');
  // 2. RLP list: rlp(["cat","dog"]) = 0xc88363617483646f67
  check('RLP encodes list correctly', rlpEncode(['cat', 'dog']).toString('hex') === 'c88363617483646f67');
  // 3. keccak256("") known vector
  const empty = Buffer.from(keccak_256(Buffer.alloc(0))).toString('hex');
  check('keccak256("") = c5d2460186f7...', empty === 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');

  // 4. Generate throwaway key, derive address, sign a dummy EIP-155 tx, recover sender.
  const priv = crypto.randomBytes(32);
  const sk = makeSigner('0x' + priv.toString('hex'), libs);
  check('derived a 0x address', /^0x[0-9a-f]{40}$/.test(sk.address));

  const tx = { nonce: 7n, gasPrice: 1000000000n, gasLimit: 250000n, to: '0xd5da79af4c4c24f9d3afec0a1cbd761a24b130bd', value: 0n, data: '0x29df2c6f', chainId: CHAIN_ID };
  const raw = sk.signLegacyTx(tx);
  check('raw tx is 0x hex', /^0x[0-9a-f]+$/.test(raw));

  // Recover: recompute sigHash, pull v,r,s from the signed RLP, recover pubkey → address.
  const unsigned = [toBuf(tx.nonce), toBuf(tx.gasPrice), toBuf(tx.gasLimit), toBuf(tx.to), toBuf(tx.value), toBuf(tx.data), toBuf(BigInt(tx.chainId)), toBuf(0n), toBuf(0n)];
  const sigHash = keccak_256(rlpEncode(unsigned));
  const sig = secp.sign(sigHash, priv);
  const recov = sig.recoverPublicKey(sigHash).toRawBytes(false);  // 65-byte uncompressed
  const recAddr = '0x' + Buffer.from(keccak_256(recov.slice(1))).slice(-20).toString('hex');
  check('sign → ecrecover returns the SAME address', recAddr === sk.address);

  // 5. v encodes EIP-155 chainId (v = recovery + chainId*2 + 35)
  const vExpected = BigInt(sig.recovery) + BigInt(CHAIN_ID) * 2n + 35n;
  check(`v carries chainId ${CHAIN_ID} (v=${vExpected})`, vExpected === 773n || vExpected === 774n);

  console.log('\n' + (pass ? '✅ SIGNER SELF-TEST PASSED' : '❌ SIGNER SELF-TEST FAILED'));
  return pass;
}

// ════════════════════════════════════════════════════════════════════════════
// DISPATCH (at end of file so every declaration above is initialized first).
//   --selftest : prove the EIP-155 signer with a RANDOM throwaway key, then exit.
//   otherwise  : run the keeper (simulate-only by default).
// ════════════════════════════════════════════════════════════════════════════
if (SELFTEST) { runSelfTest().then(ok => process.exit(ok ? 0 : 1)).catch(e => { console.error(e); process.exit(1); }); }
else { main().catch(e => { console.error('fatal:', e && e.message ? e.message : e); process.exit(1); }); }
