"use strict";

const { alertPayload, evaluateHealth } = require("./lib/production-health.cjs");

const healthUrl = process.env.PRODUCTION_HEALTH_URL || "https://arcorigin.xyz/api/health";
const webhookUrl = process.env.ALERT_WEBHOOK_URL?.trim();
const webhookFormat = process.env.ALERT_WEBHOOK_FORMAT || "slack";
const failOnDegraded = process.env.MONITOR_FAIL_ON_DEGRADED === "true";
const dryRun = process.env.MONITOR_DRY_RUN === "true";
const timeoutMs = Number(process.env.MONITOR_TIMEOUT_MS || 10_000);

async function sendAlert(message) {
  if (!webhookUrl || dryRun) {
    console.error(`[alert-not-sent] ${message}`);
    return;
  }
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(alertPayload(webhookFormat, message)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Alert webhook returned HTTP ${response.status}.`);
  }
}

async function main() {
  let payload;
  try {
    const response = await fetch(healthUrl, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    payload = await response.json();
    if (!response.ok && payload?.status !== "error") {
      throw new Error(`Health endpoint returned HTTP ${response.status}.`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await sendAlert(`ArcOrigin production health request failed: ${reason}`);
    process.exitCode = 1;
    return;
  }

  const evaluation = evaluateHealth(payload, { failOnDegraded });
  console.log(JSON.stringify({ healthUrl, evaluation, payload }, null, 2));
  if (!evaluation.healthy) {
    await sendAlert(`ArcOrigin production health failed: ${evaluation.reason}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
