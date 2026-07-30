"use strict";

function evaluateHealth(payload, { failOnDegraded = false } = {}) {
  if (!payload || typeof payload !== "object") {
    return { healthy: false, reason: "invalid_health_payload" };
  }
  if (payload.status === "error") {
    const errors = Array.isArray(payload.errors) ? payload.errors.join(",") : "unknown";
    return { healthy: false, reason: `production_health_error:${errors}` };
  }
  if (payload.status === "degraded" && failOnDegraded) {
    const warnings = Array.isArray(payload.warnings) ? payload.warnings.join(",") : "unknown";
    return { healthy: false, reason: `production_health_degraded:${warnings}` };
  }
  if (payload.status !== "ok" && payload.status !== "degraded") {
    return { healthy: false, reason: "unknown_health_status" };
  }
  return {
    healthy: true,
    reason: payload.status,
  };
}

function alertPayload(format, message) {
  if (format === "discord") return { content: message };
  if (format === "generic") return { message };
  return { text: message };
}

module.exports = { alertPayload, evaluateHealth };
