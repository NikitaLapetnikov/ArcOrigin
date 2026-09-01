"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadTypeScriptModule(relativePath) {
  const filePath = path.join(process.cwd(), relativePath);
  const source = fs.readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText;
  const loaded = { exports: {} };
  Function("require", "module", "exports", output)(require, loaded, loaded.exports);
  return loaded.exports;
}

const {
  arcOriginPoolQuoteState,
  quoteArcOriginExactInput,
} = loadTypeScriptModule("src/lib/onchain/arc-origin-v3-quote.ts");

const usdc = "0x3600000000000000000000000000000000000000";
const origin = "0xce9C0e29f8D5904bFAc3C8a79A0c9af00e6bDCcB";

test("indexed ArcOrigin quote reconstructs the permanent launch liquidity", () => {
  const latestSqrtPriceX96 = 21_788_520_718_252_306_219_987_845_169_319_778_484n;
  const state = arcOriginPoolQuoteState(origin, usdc, latestSqrtPriceX96);
  const observedLiquidity = 2_257_507_369_114_461_145n;
  const difference = state.liquidity > observedLiquidity
    ? state.liquidity - observedLiquidity
    : observedLiquidity - state.liquidity;
  assert.equal(state.tokenIsToken0, false);
  assert.equal(state.sqrtPriceX96, latestSqrtPriceX96);
  assert.ok(difference * 1_000_000n < observedLiquidity, "reconstructed liquidity must be within one ppm");
});

test("indexed ArcOrigin quote returns a conservative live ORIGIN buy", () => {
  const state = arcOriginPoolQuoteState(
    origin,
    usdc,
    21_788_520_718_252_306_219_987_845_169_319_778_484n,
  );
  const output = quoteArcOriginExactInput(state, "Buy", 1_000_000n, 10_000);
  assert.ok(output > 74_000n * 10n ** 18n);
  assert.ok(output < 75_000n * 10n ** 18n);
});

test("a new launch quotes from its active V3 boundary before the first swap", () => {
  const token0Launch = "0x245A01b04D63e11081B3e37DA196c15BB4F4577A";
  const state = arcOriginPoolQuoteState(token0Launch, usdc, null);
  const output = quoteArcOriginExactInput(state, "Buy", 1_000_000n, 10_000);
  assert.equal(state.tokenIsToken0, true);
  assert.equal(state.sqrtPriceX96, state.activeBoundarySqrtPriceX96);
  assert.ok(output > 180_000n * 10n ** 18n);
  assert.ok(output < 200_000n * 10n ** 18n);
});
