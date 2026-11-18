// ═══ Chain registry / selector ══════════════════════════════════════════════════
// v5.7.0 chain-adapter refactor. Picks the active per-chain adapter for the engine and
// keeper. Defaults to PulseChain and requires ZERO config changes: with no `chain` key
// and no ARB_CHAIN env var, active() returns the PulseChain adapter — byte-for-byte the
// same constants the code hardcoded before this refactor.
//
// Adding a chain later is purely additive — no edits to engine.js or keeper.js:
//   const bsc = require('./bsc');   REGISTRY.bsc = bsc;
// (Do NOT add bsc.js now; that is a separate, future project.)
'use strict';

const pulsechain = require('./pulsechain');

const REGISTRY = {
  pulsechain,
  // ← future adapters register here, e.g.  bsc: require('./bsc'),
};

const DEFAULT_CHAIN = 'pulsechain';

// Look up an adapter by key (case-insensitive). Returns null if unknown.
function get(key) {
  return REGISTRY[String(key || DEFAULT_CHAIN).toLowerCase()] || null;
}

// Resolve the active adapter. Selection order: explicit cfg.chain → ARB_CHAIN env →
// DEFAULT_CHAIN. Throws on an unknown key so a typo fails loudly rather than silently
// scanning the wrong chain.
function active(cfg) {
  const key = (cfg && cfg.chain) || process.env.ARB_CHAIN || DEFAULT_CHAIN;
  const adapter = get(key);
  if (!adapter) {
    throw new Error(`unknown chain "${key}" — known chains: ${Object.keys(REGISTRY).join(', ')}`);
  }
  return adapter;
}

module.exports = { active, get, DEFAULT_CHAIN, REGISTRY };
