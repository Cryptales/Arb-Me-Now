// ═══ Arb-Me-Now engine v4.3 — pure logic, no DOM. Runs in browser and Node 18+. ═══
'use strict';

const RPCS = ['https://rpc.pulsechain.com', 'https://pulsechain-rpc.publicnode.com'];
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const LIBERTY_BASE = 'https://apis.libertyswap.finance/v3';
const QUOTE_PLACEHOLDER_RECIPIENT = '0x000000000000000000000000000000000000dEaD';

// Every address/decimals pair below was read on-chain (symbol() + decimals()) on 2026-11-01.
const TOKENS = {
  WPLS: { addr: '0xa1077a294dde1b09bb078844df40758a5d0f9a27', dec: 18, name: 'Wrapped PLS' },
  PLSX: { addr: '0x95b303987a60c71504d99aa1b13b4da07b0790ab', dec: 18, name: 'PulseX' },
  HEX:  { addr: '0x2b591e99afe9f32eaa6214f7b7629768c40eeb39', dec: 8,  name: 'HEX' },
  pDAI: { addr: '0x6b175474e89094c44da98b954eedeac495271d0f', dec: 18, name: 'pDAI (forked DAI)' },
  DAI:  { addr: '0xefd766ccb38eaf1dfd701853bfce31359239f305', dec: 18, name: 'DAI (bridged from Ethereum)' },
  USDC: { addr: '0x15d38573d2feeb82e7ad5187ab8c1d52810b1f07', dec: 6,  name: 'USDC (bridged from Ethereum)' },
  eHEX: { addr: '0x57fde0a71132198bbec939b98976993d8d89d225', dec: 8,  name: 'HEX (bridged from Ethereum)' },
  INC:  { addr: '0x2fa878ab3f87cc1c9737fc071108f904c0b0c95d', dec: 18, name: 'INC (Incentive)' },
  WETH: { addr: '0x02dcdd04e3f455d838cd1249292c58f3b79e3c3c', dec: 18, name: 'WETH (bridged from Ethereum)' },
};
const PAIRS = [['WPLS','PLSX'],['WPLS','HEX'],['WPLS','pDAI'],['WPLS','DAI'],['WPLS','USDC'],['WPLS','WETH'],['USDC','DAI'],
  // v4.7: pairs probed on-chain with non-dust reserves (eHEX/USDC, WETH/USDC skipped: <$50 USDC side)
  ['WPLS','eHEX'],['HEX','eHEX'],['eHEX','DAI'],['WPLS','INC'],['PLSX','INC'],['INC','HEX'],['WETH','DAI'],['WETH','PLSX'],['WETH','HEX']];

// Fees verified: PulseX v1/v2 = 29 bps (router getAmountsOut matched exactly);
// 9mm v2 = 25 bps (back-solved from on-chain Swap/Sync events, every sample = 25.00 bps).
const V2_VENUES = {
  pulsex_v1: { label: 'PulseX v1', factory: '0x1715a3e4a142d8b698131108995174f37aeba10d', feePpm: 2900n },
  pulsex_v2: { label: 'PulseX v2', factory: '0x29ea7545def87022badc76323f373ea1e707c523', feePpm: 2900n },
  ninemm_v2: { label: '9mm v2',    factory: '0x3a0fa7884dd93f3cd234bbe2a0958ef04b05e13b', feePpm: 2500n },
};
const LIB_V3 = { label: 'LibertySwap V3', factory: '0x796fcbdc956b85797efe21145aa97599b7fb36a6', fees: [100, 500, 2500, 10000] };

// LibertySwap bridge symbols (from /v3/app/routers) mapped to PulseChain tokens.
const LIB_BRIDGE = {
  USDC: { src: 'USDC', dst: 'USDC', dstDec: 6, dstLabel: 'USDC (Ethereum)' },
  WETH: { src: 'WETH', dst: 'ETH',  dstDec: 18, dstLabel: 'ETH (Ethereum)' },
};

const SEL = {
  getPair: 'e6a43905', getPool: '1698ee82', getReserves: '0902f1ac',
  slot0: '3850c7bd', liquidity: '1a686502', tickSpacing: 'd0c93a7c', ticks: 'f30dba93',
  tryBlockAndAggregate: '399542e9',
};

const Q96 = 1n << 96n;
const MAX_U256 = (1n << 256n) - 1n;
const PPM = 1000000n;

// ─── hex / ABI helpers ────────────────────────────────────────────────────────
const strip = h => (h.startsWith('0x') ? h.slice(2) : h);
const pad32 = h => strip(h).toLowerCase().padStart(64, '0');
const u256 = n => BigInt(n).toString(16).padStart(64, '0');
const word = (hex, i) => hex.slice(i * 64, i * 64 + 64);
const wordBig = (hex, i) => BigInt('0x' + (word(hex, i) || '0'));
function wordInt24(hex, i) { // signed int24 stored in a 256-bit word
  let v = wordBig(hex, i); if (v >= (1n << 255n)) v -= (1n << 256n); return Number(v);
}
const sortTokens = (a, b) => (BigInt(a) < BigInt(b) ? [a, b] : [b, a]);

// tryBlockAndAggregate(bool requireSuccess, (address target, bytes callData)[] calls)
function encodeMulticall(calls) {
  const n = calls.length;
  const tuples = calls.map(c => {
    const data = strip(c.data);
    const len = data.length / 2;
    const padded = data.padEnd(Math.ceil(len / 32) * 64, '0');
    return pad32(c.target) + u256(64) + u256(len) + padded;
  });
  let offs = [], cur = n * 32;
  for (const t of tuples) { offs.push(u256(cur)); cur += t.length / 2; }
  return '0x' + SEL.tryBlockAndAggregate + u256(0) + u256(64) + u256(n) + offs.join('') + tuples.join('');
}
function decodeMulticall(ret) {
  const h = strip(ret);
  const block = wordBig(h, 0);
  const arr = Number(wordBig(h, 2)) * 2;           // byte offset → hex chars
  const n = Number(BigInt('0x' + h.slice(arr, arr + 64)));
  const base = arr + 64;
  const out = [];
  for (let i = 0; i < n; i++) {
    const off = base + Number(BigInt('0x' + h.slice(base + i * 64, base + i * 64 + 64))) * 2;
    const success = BigInt('0x' + h.slice(off, off + 64)) === 1n;
    const dOff = off + Number(BigInt('0x' + h.slice(off + 64, off + 128))) * 2;
    const len = Number(BigInt('0x' + h.slice(dOff, dOff + 64)));
    out.push({ success, data: h.slice(dOff + 64, dOff + 64 + len * 2) });
  }
  return { block, results: out };
}

// ─── RPC with fallback ────────────────────────────────────────────────────────
let activeRpc = RPCS[0];
async function rpc(method, params) {
  let lastErr;
  for (const url of [activeRpc, ...RPCS.filter(u => u !== activeRpc)]) {
    try {
      const t0 = Date.now();
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'RPC error');
      activeRpc = url;
      rpc.lastLatency = Date.now() - t0;
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`All RPCs failed: ${lastErr && lastErr.message}`);
}
async function multicall(calls, blockTag = 'latest') {
  const ret = await rpc('eth_call', [{ to: MULTICALL3, data: encodeMulticall(calls) }, blockTag]);
  return decodeMulticall(ret);
}

// ─── Uniswap v2 math (exact integer, matches router getAmountOut) ─────────────
function v2AmountOut(amountIn, rIn, rOut, feePpm) {
  if (amountIn <= 0n || rIn <= 0n || rOut <= 0n) return 0n;
  const inFee = amountIn * (PPM - feePpm);
  return (inFee * rOut) / (rIn * PPM + inFee);
}

// ─── Uniswap v3 math (TickMath port + single-tick-range swap) ─────────────────
const TICK_MULT = [
  [0x2, 0xfff97272373d413259a46990580e213an], [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n], [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n], [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n], [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n], [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n], [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];
function sqrtAtTick(tick) {
  const abs = Math.abs(tick);
  let ratio = (abs & 1) ? 0xfffcb933bd6fad37aa2d162d1a594001n : (1n << 128n);
  for (const [bit, m] of TICK_MULT) if (abs & bit) ratio = (ratio * m) >> 128n;
  if (tick > 0) ratio = MAX_U256 / ratio;
  return (ratio >> 32n) + ((ratio & 0xffffffffn) === 0n ? 0n : 1n);
}
const divUp = (a, b) => (a + b - 1n) / b;

// Builds an in-range model of a v3 pool. Liquidity is constant only between initialized
// ticks, which are multiples of tickSpacing, so the current spacing interval is a safe bound.
function makeV3State(sqrtP, tick, L, spacing, feePpm) {
  const lower = Math.floor(tick / spacing) * spacing;
  const upper = lower + spacing;
  return { sqrtP, tick, L, spacing, feePpm: BigInt(feePpm), sqrtLower: sqrtAtTick(lower), sqrtUpper: sqrtAtTick(upper) };
}
// Max gross input that keeps the swap inside the current interval.
function v3MaxIn(st, zeroForOne) {
  const { sqrtP, L, sqrtLower, sqrtUpper, feePpm } = st;
  let net;
  if (zeroForOne) { if (sqrtP <= sqrtLower) return 0n; net = (L * Q96 * (sqrtP - sqrtLower)) / (sqrtP * sqrtLower); }
  else { if (sqrtUpper <= sqrtP) return 0n; net = (L * (sqrtUpper - sqrtP)) / Q96; }
  return (net * PPM) / (PPM - feePpm); // round down → conservative
}
// Exact output for an input that stays inside the interval; null if it would cross a tick.
function v3AmountOut(amountIn, st, zeroForOne) {
  if (amountIn <= 0n || st.L === 0n) return 0n;
  if (amountIn > v3MaxIn(st, zeroForOne)) return null;
  const { sqrtP, L, feePpm } = st;
  const net = (amountIn * (PPM - feePpm)) / PPM;
  if (zeroForOne) {
    const num = L * Q96;
    const sqrtQ = divUp(num * sqrtP, num + net * sqrtP);
    return (L * (sqrtP - sqrtQ)) / Q96;
  } else {
    const sqrtQ = sqrtP + (net * Q96) / L;
    return (L * Q96 * (sqrtQ - sqrtP)) / (sqrtQ * sqrtP);
  }
}

// ─── Multi-tick v3 (v4.5) ──────────────────────────────────────────────────────
// Liquidity only changes at initialized ticks (multiples of tickSpacing). We read ticks(t) for the
// V3_INTERVALS boundaries on each side of the price and build piecewise-constant-L intervals.
// Crossing a tick upward adds liquidityNet; downward subtracts it (uninitialized ticks have net 0).
let V3_INTERVALS = 4;         // default; UI slider writes v3DepthCap before each scan
let v3DepthCap = 4;            // upper bound from the slider
const MIN_TICK = -887272, MAX_TICK = 887272;
// Adaptive depth (v4.8). Capacity of the CURRENT interval, expressed in start-token (S) units,
// taking the tighter of the two swap directions (S in, and the other token in, converted to S at
// the pool price). Pools that do not contain S (intermediate legs of 3-hop routes) get the full cap.
function v3SingleIntervalCapS(p, S) {
  const st = p.st; if (!st || st.L === 0n) return 0n;
  const P = st.sqrtP * st.sqrtP;                     // token1/token0 price × 2^192
  const SHIFT = 1n << 192n;
  if (p.token0 === S) {
    const inS = v3MaxIn(st, true);                   // S (token0) in
    const in1 = v3MaxIn(st, false);                  // token1 in → convert to token0 units
    const in1asS = P > 0n ? (in1 * SHIFT) / P : 0n;
    return inS < in1asS ? inS : in1asS;
  }
  if (p.token1 === S) {
    const inS = v3MaxIn(st, false);                  // S (token1) in
    const in0 = v3MaxIn(st, true);                   // token0 in → convert to token1 units
    const in0asS = (in0 * P) / SHIFT;
    return inS < in0asS ? inS : in0asS;
  }
  return -1n;                                        // does not contain S
}
// Number of tick intervals to read for one pool: enough to cover the user's size, capped by the slider.
function adaptiveDepth(p, userAmt, S) {
  if (v3DepthCap <= 1) return 1;
  if (!userAmt || userAmt <= 0n || !S) return v3DepthCap;
  const cap1 = v3SingleIntervalCapS(p, S);
  if (cap1 < 0n || cap1 === 0n) return v3DepthCap;
  const needed = Number(userAmt / cap1) + 2;         // +1 rounding, +1 safety margin
  return Math.max(2, Math.min(v3DepthCap, needed));  // never fewer than 2 when cap > 1
}
function setV3DepthCap(n) { v3DepthCap = Math.max(1, Math.min(8, Math.floor(Number(n) || 4))); V3_INTERVALS = v3DepthCap; }
function v3BoundaryTicks(tick, spacing, depth) {
  depth = depth || V3_INTERVALS;
  const lower = Math.floor(tick / spacing) * spacing, upper = lower + spacing, down = [], up = [];
  for (let k = 0; k < depth; k++) {
    if (lower - k * spacing >= MIN_TICK) down.push(lower - k * spacing);
    if (upper + k * spacing <= MAX_TICK) up.push(upper + k * spacing);
  }
  return { down, up };
}
// netByTick: Map tick -> liquidityNet (BigInt). Returns intervals ordered away from the current price.
function buildV3Intervals(st, netByTick, depth) {
  const { down, up } = v3BoundaryTicks(st.tick, st.spacing, depth || V3_INTERVALS);
  const intervalsDown = [], intervalsUp = [];
  let L = st.L, cur = st.sqrtP;
  for (const t of down) {               // price moving down: [sqrt(t), cur] at L, then cross t
    if (L <= 0n) break;
    const lo = sqrtAtTick(t); intervalsDown.push({ sqrtLo: lo, sqrtHi: cur, L });
    if (!netByTick.has(t)) break;        // unknown tick data → stop (conservative)
    L -= netByTick.get(t); cur = lo;
  }
  L = st.L; cur = st.sqrtP;
  for (const t of up) {                 // price moving up: [cur, sqrt(t)] at L, then cross t
    if (L <= 0n) break;
    const hi = sqrtAtTick(t); intervalsUp.push({ sqrtLo: cur, sqrtHi: hi, L });
    if (!netByTick.has(t)) break;
    L += netByTick.get(t); cur = hi;
  }
  return { ...st, intervalsDown, intervalsUp };
}
function v3MaxInMulti(st, zeroForOne) {
  const iv = zeroForOne ? st.intervalsDown : st.intervalsUp;
  let net = 0n;
  for (const { sqrtLo, sqrtHi, L } of iv) {
    if (sqrtHi <= sqrtLo) continue;
    net += zeroForOne ? (L * Q96 * (sqrtHi - sqrtLo)) / (sqrtHi * sqrtLo) : (L * (sqrtHi - sqrtLo)) / Q96;
  }
  return (net * PPM) / (PPM - st.feePpm);
}
// Steps through intervals; fee is taken on the gross input (sum of per-step fees, rounding aside).
function v3AmountOutMulti(amountIn, st, zeroForOne) {
  if (amountIn <= 0n) return 0n;
  if (amountIn > v3MaxInMulti(st, zeroForOne)) return null;
  let rem = (amountIn * (PPM - st.feePpm)) / PPM, out = 0n;
  const iv = zeroForOne ? st.intervalsDown : st.intervalsUp;
  for (const { sqrtLo, sqrtHi, L } of iv) {
    if (rem <= 0n) break;
    if (sqrtHi <= sqrtLo || L <= 0n) continue;
    if (zeroForOne) {                   // start at sqrtHi, move toward sqrtLo
      const cap = (L * Q96 * (sqrtHi - sqrtLo)) / (sqrtHi * sqrtLo);
      if (rem <= cap) { const num = L * Q96; const q = divUp(num * sqrtHi, num + rem * sqrtHi); out += (L * (sqrtHi - q)) / Q96; rem = 0n; break; }
      out += (L * (sqrtHi - sqrtLo)) / Q96; rem -= cap;
    } else {                            // start at sqrtLo, move toward sqrtHi
      const cap = (L * (sqrtHi - sqrtLo)) / Q96;
      if (rem <= cap) { const q = sqrtLo + (rem * Q96) / L; out += (L * Q96 * (q - sqrtLo)) / (q * sqrtLo); rem = 0n; break; }
      out += (L * Q96 * (sqrtHi - sqrtLo)) / (sqrtHi * sqrtLo); rem -= cap;
    }
  }
  return rem > 0n ? null : out;
}
const hasMulti = st => !!(st && st.intervalsDown && st.intervalsUp);

// ─── Generic leg: quote(amountIn) and maxIn for a pool + direction ────────────
function makeLeg(pool, tokenIn) {
  const zeroForOne = tokenIn === pool.token0;
  if (pool.kind === 'v2') {
    const [rIn, rOut] = zeroForOne ? [pool.r0, pool.r1] : [pool.r1, pool.r0];
    return { pool, tokenIn, rIn, rOut, maxIn: rIn / 10n, // cap at 10% of input reserve
      quote: x => v2AmountOut(x, rIn, rOut, pool.feePpm) };
  }
  if (hasMulti(pool.st)) {
    const iv = zeroForOne ? pool.st.intervalsDown : pool.st.intervalsUp;
    return { pool, tokenIn, multi: iv.length, maxIn: v3MaxInMulti(pool.st, zeroForOne), quote: x => v3AmountOutMulti(x, pool.st, zeroForOne) };
  }
  return { pool, tokenIn, maxIn: v3MaxIn(pool.st, zeroForOne), quote: x => v3AmountOut(x, pool.st, zeroForOne) };
}

// Mid price (tokenOut per tokenIn, raw units) as a float — display only.
function midRaw(leg) {
  const p = leg.pool;
  if (p.kind === 'v2') return Number(leg.rOut) / Number(leg.rIn);
  const px = (Number(p.st.sqrtP) / 2 ** 96) ** 2; // token1 per token0
  return leg.tokenIn === p.token0 ? px : 1 / px;
}

// Two-leg cycle S→Y on legA, Y→S on legB. Returns optimal size (ternary search on the concave profit curve).
function evalCycle(legA, legB, amount) {
  const outA = legA.quote(amount); if (outA === null || outA === 0n) return null;
  if (outA > legB.maxIn) return null;
  const outB = legB.quote(outA); if (outB === null) return null;
  return { amountIn: amount, mid: outA, amountOut: outB, profit: outB - amount };
}
function maxCycleInput(legA, legB) {
  // largest x ≤ legA.maxIn whose leg-A output stays within legB.maxIn (outputs are monotone in x)
  let lo = 0n, hi = legA.maxIn;
  const ok = x => { const o = legA.quote(x); return o !== null && o <= legB.maxIn; };
  if (hi === 0n) return 0n;
  if (ok(hi)) return hi;
  for (let i = 0; i < 200 && hi - lo > 1n; i++) { const m = (lo + hi) / 2n; if (ok(m)) lo = m; else hi = m; }
  return lo;
}
function findOptimal(legA, legB) {
  const xmax = maxCycleInput(legA, legB);
  if (xmax <= 0n) return null;
  const p = x => { const r = evalCycle(legA, legB, x); return r ? r.profit : -(1n << 255n); };
  let lo = 0n, hi = xmax;
  for (let i = 0; i < 300 && hi - lo > 2n; i++) {
    const m1 = lo + (hi - lo) / 3n, m2 = hi - (hi - lo) / 3n;
    if (p(m1) < p(m2)) lo = m1; else hi = m2;
  }
  let best = null;
  for (let x = lo; x <= hi; x++) { const r = evalCycle(legA, legB, x); if (r && (!best || r.profit > best.profit)) best = r; }
  return best && best.profit > 0n ? { ...best, cap: xmax } : { ...(best || {}), profit: best ? best.profit : 0n, cap: xmax, unprofitable: true };
}

// ─── Discovery + atomic state fetch ───────────────────────────────────────────
async function discoverPools(enabled) {
  const calls = [], meta = [];
  for (const [a, b] of PAIRS) {
    const A = TOKENS[a].addr, B = TOKENS[b].addr;
    for (const [id, v] of Object.entries(V2_VENUES)) {
      if (!enabled[id]) continue;
      calls.push({ target: v.factory, data: SEL.getPair + pad32(A) + pad32(B) });
      meta.push({ kind: 'v2', venue: id, label: v.label, feePpm: v.feePpm, a, b });
    }
    if (enabled.liberty_v3) for (const fee of LIB_V3.fees) {
      calls.push({ target: LIB_V3.factory, data: SEL.getPool + pad32(A) + pad32(B) + u256(fee) });
      meta.push({ kind: 'v3', venue: 'liberty_v3', label: `${LIB_V3.label} ${fee / 10000}%`, feePpm: BigInt(fee), a, b });
    }
  }
  if (!calls.length) return [];
  const { results } = await multicall(calls);
  const pools = [];
  results.forEach((r, i) => {
    if (!r.success || r.data.length < 64) return;
    const addr = '0x' + r.data.slice(24, 64);
    if (BigInt(addr) === 0n) return;
    const m = meta[i];
    const [t0, t1] = sortTokens(TOKENS[m.a].addr, TOKENS[m.b].addr);
    pools.push({ ...m, address: addr, token0: t0, token1: t1 });
  });
  return pools;
}

async function fetchPoolStates(pools, userAmountRaw, startAddr) {
  const calls = [], idx = [];
  pools.forEach((p, i) => {
    if (p.kind === 'v2') { calls.push({ target: p.address, data: SEL.getReserves }); idx.push([i, 'res']); }
    else {
      calls.push({ target: p.address, data: SEL.slot0 }); idx.push([i, 'slot0']);
      calls.push({ target: p.address, data: SEL.liquidity }); idx.push([i, 'liq']);
      calls.push({ target: p.address, data: SEL.tickSpacing }); idx.push([i, 'ts']);
    }
  });
  const { block, results } = await multicall(calls);
  const tmp = pools.map(p => ({ ...p }));
  results.forEach((r, k) => {
    const [i, f] = idx[k]; const p = tmp[i];
    if (!r.success) { p.bad = true; return; }
    if (f === 'res') { p.r0 = wordBig(r.data, 0); p.r1 = wordBig(r.data, 1); p.tsLast = Number(wordBig(r.data, 2)); }
    if (f === 'slot0') { p.sqrtP = wordBig(r.data, 0); p.tick = wordInt24(r.data, 1); }
    if (f === 'liq') p.L = wordBig(r.data, 0);
    if (f === 'ts') p.spacing = Number(wordBig(r.data, 0));
  });
  const live = [];
  for (const p of tmp) {
    if (p.bad) continue;
    if (p.kind === 'v2') { if (p.r0 > 0n && p.r1 > 0n) live.push(p); }
    else if (p.L > 0n && p.spacing > 0) { p.st = makeV3State(p.sqrtP, p.tick, p.L, p.spacing, p.feePpm); live.push(p); }
  }
  // Second pass at the SAME block: tick boundaries — per-pool adaptive depth up to v3DepthCap.
  const tcalls = [], tidx = [];
  live.filter(p => p.kind === 'v3').forEach(p => {
    const d = adaptiveDepth(p, userAmountRaw || 0n, startAddr);
    p._tickDepth = d;   // store for telemetry
    const { down, up } = v3BoundaryTicks(p.tick, p.spacing, d);
    for (const t of [...down, ...up]) {
      tcalls.push({ target: p.address, data: SEL.ticks + BigInt.asUintN(256, BigInt(t)).toString(16).padStart(64, '0') });
      tidx.push([p, t]);
    }
  });
  if (tcalls.length) {
    try {
      const tr = await multicall(tcalls, '0x' + BigInt(block).toString(16));
      const maps = new Map();
      tr.results.forEach((r, k) => {
        const [p, t] = tidx[k];
        if (!maps.has(p)) maps.set(p, new Map());
        if (r.success && r.data.length >= 128) maps.get(p).set(t, BigInt.asIntN(256, wordBig(r.data, 1)));
      });
      for (const [p, m] of maps) p.st = buildV3Intervals(p.st, m, p._tickDepth);
    } catch (e) { /* fall back to single-interval v3 */ }
  }
  return { block: Number(block), pools: live };
}

// ─── Scan: every 2-venue cycle for the chosen start token ─────────────────────
function scanCycles(pools, startSym, userAmountRaw) {
  const S = TOKENS[startSym].addr;
  const byOther = {};
  for (const p of pools) {
    if (p.token0 !== S && p.token1 !== S) continue;
    const other = p.token0 === S ? p.token1 : p.token0;
    (byOther[other] = byOther[other] || []).push(p);
  }
  const rows = [];
  for (const [Y, list] of Object.entries(byOther)) {
    for (const pa of list) for (const pb of list) {
      if (pa === pb) continue;
      const legA = makeLeg(pa, S), legB = makeLeg(pb, Y);
      const opt = findOptimal(legA, legB);
      const user = userAmountRaw > 0n ? evalCycle(legA, legB, userAmountRaw) : null;
      const midEdge = midRaw(legA) * midRaw(legB) - 1; // gross price gap incl. nothing
      rows.push({ startSym, otherAddr: Y, legA, legB, opt, user, midEdge,
        userExceedsCap: userAmountRaw > 0n && !user });
    }
  }
  return rows;
}

// USD value of 1 WPLS from the deepest WPLS/USDC or WPLS/DAI v2 pool (by stable reserve).
function wplsUsd(pools) {
  let best = null;
  for (const p of pools) {
    if (p.kind !== 'v2') continue;
    const syms = [p.a, p.b];
    if (!syms.includes('WPLS')) continue;
    const st = syms.find(s => s === 'USDC' || s === 'DAI'); if (!st) continue;
    const isW0 = p.token0 === TOKENS.WPLS.addr;
    const rW = isW0 ? p.r0 : p.r1, rS = isW0 ? p.r1 : p.r0;
    const stableUnits = Number(rS) / 10 ** TOKENS[st].dec;
    if (!best || stableUnits > best.depth) best = { depth: stableUnits, price: stableUnits / (Number(rW) / 1e18), src: `${p.label} WPLS/${st}` };
  }
  return best;
}
// USD price for any token via its deepest WPLS pool (v2 only), or 1.0 for the bridged stables' own quote.
function tokenUsd(sym, pools, wpls) {
  if (!wpls) return null;
  if (sym === 'WPLS') return wpls.price;
  let best = null;
  for (const p of pools) {
    if (p.kind !== 'v2' || ![p.a, p.b].includes('WPLS') || ![p.a, p.b].includes(sym)) continue;
    const isW0 = p.token0 === TOKENS.WPLS.addr;
    const rW = Number(isW0 ? p.r0 : p.r1) / 1e18, rT = Number(isW0 ? p.r1 : p.r0) / 10 ** TOKENS[sym].dec;
    if (!best || rW > best.depth) best = { depth: rW, price: (rW / rT) * wpls.price };
  }
  return best ? best.price : null;
}

// ─── LibertySwap bridge API (schema verified with live quotes 2026-11-01) ─────
const libLimiter = { stamps: [], limit: 30, reserve: 2,
  take() { const now = Date.now(); this.stamps = this.stamps.filter(t => now - t < 60000);
    if (this.stamps.length >= this.limit - this.reserve) return false; this.stamps.push(now); return true; } };

async function libertyRouters() {
  const t0 = Date.now();
  const r = await fetch(`${LIBERTY_BASE}/app/routers`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return { latency: Date.now() - t0, routers: j.data || [] };
}
// Returns { srcAmount, destAmount, feePct, feeAmount, route } — field names as returned by the API.
async function libertyQuote(srcSym, dstSym, amountRaw, srcChain, dstChain, recipient) {
  if (!libLimiter.take()) throw new Error('Local rate-limit guard (30 req/60 s) reached');
  const q = new URLSearchParams({ srcToken: srcSym, dstToken: dstSym, amount: amountRaw.toString(),
    srcChain: String(srcChain), dstChain: String(dstChain), recipient: recipient || QUOTE_PLACEHOLDER_RECIPIENT });
  const t0 = Date.now();
  const r = await fetch(`${LIBERTY_BASE}/swap/quote?${q}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return { latency: Date.now() - t0, srcAmount: BigInt(j.srcAmount), destAmount: BigInt(j.destAmount),
    feePct: j.fee && j.fee.protocol ? j.fee.protocol.percentage : null,
    feeAmount: j.fee && j.fee.total ? BigInt(j.fee.total.amount) : null,
    route: j.route && j.route.type, srcToken: j.srcToken, destToken: j.destToken };
}

// ─── v4.8.1: Piteas aggregator cross-check (read-only, opt-in) ───────────────
// Piteas allows 10 req/min (exceeding it can block the IP for 1 h) and says its API is not for
// arb bots, so this is a manual button only, with a local cap of 6 requests per rolling 60 s.
const PITEAS_QUOTE = 'https://sdk.piteas.io/quote';
const PITEAS_ROUTER = '0x6BF228eb7F8ad948d37deD07E595EfddfaAF88A6';
const piteasLimiter = { stamps: [], limit: 6,
  take() { const now = Date.now(); this.stamps = this.stamps.filter(t => now - t < 60000);
    if (this.stamps.length >= this.limit) return false; this.stamps.push(now); return true; } };
// Returns { latency, destAmount, gasUseEstimate, venues:[...], path:[symbols] }.
async function piteasQuote(srcAddr, dstAddr, amountRaw) {
  if (!piteasLimiter.take()) throw new Error('Local Piteas guard (6 req/60 s) reached — wait a minute');
  const q = new URLSearchParams({ tokenInAddress: srcAddr, tokenOutAddress: dstAddr, amount: amountRaw.toString(), allowedSlippage: '0.5' });
  const t0 = Date.now();
  let r;
  try { r = await fetch(`${PITEAS_QUOTE}?${q}`); } catch (e) { throw new Error('Piteas unreachable (network/CORS)'); }
  if (r.status === 429) throw new Error('Piteas rate limit hit (HTTP 429) — stop for at least an hour');
  if (!r.ok) throw new Error(`Piteas unavailable (HTTP ${r.status})`);
  const j = await r.json().catch(() => null);
  if (!j || j.destAmount == null) throw new Error('Piteas returned no quote');
  const venues = new Set();
  const walk = s => (s || []).forEach(x => { (x.subswaps || []).forEach(ss => (ss.paths || []).forEach(p => p.exchange && venues.add(p.exchange))); });
  if (j.route) walk(j.route.swaps);
  const path = j.route && j.route.paths && j.route.paths[0] ? j.route.paths[0].map(t => t.symbol) : [];
  return { latency: Date.now() - t0, destAmount: BigInt(j.destAmount), gasUseEstimate: j.gasUseEstimate || null, venues: [...venues], path };
}

// ─── formatting ───────────────────────────────────────────────────────────────
function fmtUnits(raw, dec, maxFrac = 6) {
  const neg = raw < 0n; let v = neg ? -raw : raw;
  const base = 10n ** BigInt(dec);
  const ip = v / base; let fp = (v % base).toString().padStart(dec, '0').slice(0, maxFrac).replace(/0+$/, '');
  return (neg ? '-' : '') + ip.toLocaleString('en-US') + (fp ? '.' + fp : '');
}
function parseUnits(str, dec) {
  const s = String(str).trim(); if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') return 0n;
  const [i, f = ''] = s.split('.');
  return BigInt(i || '0') * 10n ** BigInt(dec) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0');
}
const symOf = addr => Object.keys(TOKENS).find(k => TOKENS[k].addr === addr) || addr.slice(0, 8);


// ─── ArbExecutor (v4.6): atomic flash-swap execution contract helpers ────────
// Leg packing must match contracts/src/ArbExecutor.sol:
// bits 0-159 pool | 160-167 kind (0 v2, 1 v3) | 168-175 zeroForOne | 176-191 v2 fee (bps).
const EXEC = { selExecute: '0x29df2c6f', selOwner: '0x8da5cb5b', errors: {
  '0x31708d59': 'NoProfit', '0x30cd7471': 'NotOwner', '0x203d82d8': 'Expired', '0xc4c321d1': 'BadRoute',
  '0x6c25f7f8': 'BadCallback', '0x3ef33375': 'Busy', '0x90b8ec18': 'TransferFailed',
  '0xea8e4eb5': 'NotAuthorized' } }; // NotAuthorized: v4.9 keeper-role contract
function packLeg(leg) {
  const p = leg.pool;
  const zf = leg.tokenIn.toLowerCase() === p.token0.toLowerCase() ? 1n : 0n;
  const kind = p.kind === 'v3' ? 1n : 0n;
  const fee = p.kind === 'v2' ? BigInt(p.feePpm) / 100n : 0n; // feePpm 2900 -> 29 bps
  return BigInt(p.address) | (kind << 160n) | (zf << 168n) | (fee << 176n);
}
function encodeExecute(packedLegs, amountIn, minProfit, deadline) {
  const w = x => BigInt(x).toString(16).padStart(64, '0');
  return EXEC.selExecute + w(128) + w(amountIn) + w(minProfit) + w(deadline) + w(packedLegs.length) + packedLegs.map(w).join('');
}
// Read-only dry run: eth_call execute() from the contract owner. Never signs anything.
async function rpcFull(method, params) { // like rpc(), but returns the raw JSON so revert data is kept
  let lastErr;
  for (const url of [activeRpc, ...RPCS.filter(u => u !== activeRpc)]) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all RPCs failed');
}
function decodeRevert(data) {
  if (typeof data !== 'string' || data.length < 10) return { name: 'Revert', detail: 'no revert data' };
  const sel = data.slice(0, 10).toLowerCase(), name = EXEC.errors[sel];
  if (name === 'NoProfit') return { name, returned: BigInt('0x' + data.slice(10, 74)), required: BigInt('0x' + data.slice(74, 138)) };
  if (sel === '0x08c379a0') { // Error(string)
    const len = parseInt(data.slice(74, 138), 16); const hex = data.slice(138, 138 + len * 2);
    return { name: 'Error', detail: decodeURIComponent(hex.replace(/(..)/g, '%$1')) };
  }
  return { name: name || 'Revert', detail: name ? '' : sel };
}
async function simulateExecute(executor, calldata) {
  const o = await rpcFull('eth_call', [{ to: executor, data: EXEC.selOwner }, 'latest']);
  if (o.error || !o.result || o.result.length < 66) throw new Error('not an ArbExecutor (owner() failed) at ' + executor);
  const owner = '0x' + o.result.slice(26, 66);
  const j = await rpcFull('eth_call', [{ from: owner, to: executor, data: calldata, gas: '0x' + (3000000).toString(16) }, 'latest']);
  if (j.error) {
    const data = typeof j.error.data === 'string' ? j.error.data : (j.error.data && j.error.data.data);
    return { ok: false, owner, ...decodeRevert(data), message: j.error.message };
  }
  let gas = null;
  try { const g = await rpcFull('eth_estimateGas', [{ from: owner, to: executor, data: calldata }]); if (g && g.result) gas = BigInt(g.result); } catch (e) {}
  return { ok: true, owner, profit: BigInt(j.result.slice(0, 66)), gas };
}
function setRpcs(urls) { RPCS.splice(0, RPCS.length, ...urls); activeRpc = RPCS[0]; }

if (typeof module !== 'undefined') module.exports = { TOKENS, PAIRS, V2_VENUES, LIB_V3, LIB_BRIDGE, rpc, multicall,
  encodeMulticall, decodeMulticall, v2AmountOut, sqrtAtTick, makeV3State, v3MaxIn, v3AmountOut, buildV3Intervals, v3MaxInMulti, v3AmountOutMulti, makeLeg, findOptimal,
  evalCycle, discoverPools, EXEC, packLeg, encodeExecute, decodeRevert, simulateExecute, setRpcs, fetchPoolStates, setV3DepthCap, adaptiveDepth, v3SingleIntervalCapS, scanCycles, wplsUsd, tokenUsd, libertyRouters, libertyQuote, fmtUnits, parseUnits, symOf };

// ─── Triangular scan: S → Y → Z → S across 3 pools ──────────────────────────
// Returns rows sorted by profitability. Each row has legA (S→Y), legB (Y→Z), legC (Z→S).
function scanTriangular(pools, startSym, userAmountRaw) {
  const S = TOKENS[startSym].addr;
  // Build adjacency: for each token pair, list of pools
  const adj = {}; // adj[tokenA][tokenB] = [pool, ...]
  const addEdge = (from, to, pool) => { (adj[from] = adj[from] || {}); (adj[from][to] = adj[from][to] || []).push(pool); };
  for (const p of pools) { addEdge(p.token0, p.token1, p); addEdge(p.token1, p.token0, p); }
  const rows = [];
  // S → Y pools
  if (!adj[S]) return rows;
  for (const [Y, poolsSY] of Object.entries(adj[S])) {
    if (Y === S) continue;
    if (!adj[Y]) continue;
    // Y → Z pools (Z ≠ S, Z ≠ Y)
    for (const [Z, poolsYZ] of Object.entries(adj[Y])) {
      if (Z === S || Z === Y) continue;
      // Z → S pools
      if (!adj[Z] || !adj[Z][S]) continue;
      const poolsZS = adj[Z][S];
      for (const pa of poolsSY) for (const pb of poolsYZ) for (const pc of poolsZS) {
        if (pa === pb || pb === pc || pa === pc) continue;
        const legA = makeLeg(pa, S);
        const legB = makeLeg(pb, Y);
        const legC = makeLeg(pc, Z);
        // find optimal: binary search for feasible max, ternary on profit
        const xmax = (() => {
          let lo = 0n, hi = legA.maxIn;
          if (hi === 0n) return 0n;
          const ok = x => {
            const oA = legA.quote(x); if (oA === null || oA === 0n || oA > legB.maxIn) return false;
            const oB = legB.quote(oA); if (oB === null || oB === 0n || oB > legC.maxIn) return false;
            return true;
          };
          if (!ok(hi)) { for (let i = 0; i < 200 && hi - lo > 1n; i++) { const m = (lo + hi) / 2n; if (ok(m)) lo = m; else hi = m; } }
          return lo;
        })();
        if (xmax <= 0n) continue;
        const profit3 = x => {
          const oA = legA.quote(x); if (oA === null || oA > legB.maxIn) return -(1n << 200n);
          const oB = legB.quote(oA); if (oB === null || oB > legC.maxIn) return -(1n << 200n);
          const oC = legC.quote(oB); if (oC === null) return -(1n << 200n);
          return oC - x;
        };
        let lo = 0n, hi = xmax;
        for (let i = 0; i < 200 && hi - lo > 2n; i++) {
          const m1 = lo + (hi - lo) / 3n, m2 = hi - (hi - lo) / 3n;
          if (profit3(m1) < profit3(m2)) lo = m1; else hi = m2;
        }
        let opt = null;
        for (let x = lo; x <= hi; x++) {
          const pr = profit3(x); if (pr > (opt ? opt.profit : -(1n << 200n))) {
            const oA = legA.quote(x), oB = oA && legB.quote(oA), oC = oB && legC.quote(oB);
            if (oC !== null) opt = { amountIn: x, midAB: oA, midBC: oB, amountOut: oC, profit: pr, cap: xmax };
          }
        }
        if (!opt || opt.profit <= 0n) continue; // skip unprofitable for tri
        const midEdge = midRaw(legA) * midRaw(legB) * midRaw(legC) - 1;
        let user = null, userExceedsCap = false;
        if (userAmountRaw > 0n) {
          const p3 = profit3(userAmountRaw);
          if (p3 > -(1n << 200n)) { const oA = legA.quote(userAmountRaw), oB = oA && legB.quote(oA), oC = oB && legC.quote(oB); if (oC !== null) user = { amountIn: userAmountRaw, midAB: oA, midBC: oB, amountOut: oC, profit: p3 }; }
          else userExceedsCap = true;
        }
        rows.push({ kind: 'tri', startSym, midSymY: symOf(Y), midSymZ: symOf(Z), legA, legB, legC, opt, user, midEdge, userExceedsCap });
      }
    }
  }
  return rows;
}

if (typeof module !== 'undefined') { const m = module.exports || {}; Object.assign(m, { scanTriangular }); module.exports = m; }
