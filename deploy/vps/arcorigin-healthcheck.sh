#!/bin/sh

set -eu

health_url="http://127.0.0.1:3100/api/health"
home_url="http://127.0.0.1:3100/"

check_service() {
  curl --fail --silent --show-error --max-time 20 "$home_url" >/dev/null \
    && curl --fail --silent --show-error --max-time 30 "$health_url" \
      | grep -Eq '"status":"(ok|degraded)"'
}

if check_service; then
  exit 0
fi

logger -t arcorigin-healthcheck "Health check failed; restarting arcorigin.service"
systemctl restart arcorigin.service
sleep 5

if check_service; then
  logger -t arcorigin-healthcheck "ArcOrigin recovered after restart"
  exit 0
fi

logger -t arcorigin-healthcheck "ArcOrigin health check still fails after restart"
exit 1
