// ═══ Chain adapter: PulseChain (chainId 369) ════════════════════════════════════
// v5.7.0 chain-adapter refactor. This module is the SINGLE source of truth for every
// PulseChain-specific parameter that the engine and keeper used to hardcode: tokens,
// DEX venues, V3 factory/fee tiers, the wrapped-native token, Multicall3, the public
// RPC endpoints, and the MEV/submission relay defaults.
//
// IMPORTANT — behavior-preserving: every address, decimal, fee tier, and endpoint
// below is copied VERBATIM from the pre-refactor engine.js / server/keeper.js. Do not
// "clean up" casing or values here — they are matched byte-for-byte on purpose so the
// live PulseChain bot behaves identically. Adding another chain is purely additive:
// drop in chains/<name>.js with this same shape and register it in chains/index.js.
'use strict';

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

module.exports = {
  key: 'pulsechain',
  chainId: 369,                                           // PulseChain mainnet
  name: 'PulseChain',
  nativeSymbol: 'PLS',
  // Wrapped-native mirror of TOKENS.WPLS (same address/decimals; engine still indexes TOKENS).
  wrappedNative: { symbol: 'WPLS', addr: '0xa1077a294dde1b09bb078844df40758a5d0f9a27', dec: 18 },

  // ── Market data (DEX venues, tokens, pairs) ──
  tokens:   TOKENS,
  pairs:    PAIRS,
  v2Venues: V2_VENUES,
  v3:       LIB_V3,
  bridge:   LIB_BRIDGE,
  libertyBase: 'https://apis.libertyswap.finance/v3',

  // ── Network ──
  multicall3: '0xca11bde05977b3631167028862be2a173976ca11',
  // Engine's built-in public-RPC fallback list (used standalone / in tests; the keeper and
  // scanner override this at runtime via E.setRpcs(config.rpc_urls)).
  rpcs: ['https://rpc.pulsechain.com', 'https://pulsechain-rpc.publicnode.com'],

  // ── Submission / MEV relay defaults (keeper reads these when config.json omits them) ──
  submission: {
    defaultMode: 'private',                               // submission_mode default
    publicRpcDefault: ['https://rpc.pulsechain.com'],     // rpc_urls default (single public endpoint)
    privateRpc: 'https://rpc.blockferret.win',            // private_rpc_url default (BlockFerret, out of public mempool)
    bundleRpc:  'https://rpc.blockferret.win/builders',   // bundle_rpc_url default (eth_sendBundle /builders)
  },
};
