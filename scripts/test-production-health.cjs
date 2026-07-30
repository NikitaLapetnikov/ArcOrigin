"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { alertPayload, evaluateHealth } = require("./lib/production-health.cjs");

test("healthy and degraded payloads are accepted by default", () => {
  assert.equal(evaluateHealth({ status: "ok" }).healthy, true);
  assert.equal(evaluateHealth({ status: "degraded", warnings: ["cache"] }).healthy, true);
});

test("degraded payload can fail a strict monitor", () => {
  const result = evaluateHealth(
    { status: "degraded", warnings: ["indexer_lagging"] },
    { failOnDegraded: true },
  );
  assert.equal(result.healthy, false);
  assert.match(result.reason, /indexer_lagging/);
});

test("error and malformed payloads fail closed", () => {
  assert.equal(evaluateHealth({ status: "error", errors: ["rpc"] }).healthy, false);
  assert.equal(evaluateHealth(null).healthy, false);
  assert.equal(evaluateHealth({ status: "mystery" }).healthy, false);
});

test("alert payloads use the configured webhook shape", () => {
  assert.deepEqual(alertPayload("slack", "down"), { text: "down" });
  assert.deepEqual(alertPayload("discord", "down"), { content: "down" });
  assert.deepEqual(alertPayload("generic", "down"), { message: "down" });
});
