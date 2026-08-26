#!/bin/sh

set -eu

health_url="${ARCORIGIN_HEALTH_URL:-http://127.0.0.1:3100/api/health}"
home_url="${ARCORIGIN_HOME_URL:-http://127.0.0.1:3100/}"
service_name="${ARCORIGIN_SERVICE:-arcorigin.service}"
logger_tag="${ARCORIGIN_LOGGER_TAG:-arcorigin-healthcheck}"
warmup_url="${ARCORIGIN_WARMUP_URL:-}"

warm_index() {
  if [ -n "$warmup_url" ]; then
    curl --fail --silent --show-error --max-time 30 "$warmup_url" >/dev/null || true
  fi
}

check_service() {
  curl --fail --silent --show-error --max-time 20 "$home_url" >/dev/null \
    && curl --fail --silent --show-error --max-time 30 "$health_url" \
      | grep -Eq '"status":"(ok|degraded)"'
}

warm_index
if check_service; then
  exit 0
fi

logger -t "$logger_tag" "Health check failed; restarting $service_name"
systemctl restart "$service_name"
sleep 5

warm_index
if check_service; then
  logger -t "$logger_tag" "$service_name recovered after restart"
  exit 0
fi

logger -t "$logger_tag" "$service_name health check still fails after restart"
exit 1
