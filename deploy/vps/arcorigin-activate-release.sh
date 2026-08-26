#!/bin/sh

set -eu

root="${ARCORIGIN_ROOT:-/opt/arcorigin}"
service_name="${ARCORIGIN_SERVICE:-arcorigin.service}"
health_timer="${ARCORIGIN_HEALTH_TIMER:-arcorigin-healthcheck.timer}"
port="${ARCORIGIN_PORT:-3100}"

if [ "$#" -ne 1 ]; then
  echo "Usage: $(basename "$0") $root/releases/<release>" >&2
  exit 2
fi

candidate=$(readlink -f "$1")
case "$candidate" in
  "$root"/releases/*) ;;
  *)
    echo "Refusing release outside $root/releases." >&2
    exit 2
    ;;
esac

if [ ! -f "$candidate/.next/BUILD_ID" ] || [ ! -x "$candidate/node_modules/.bin/next" ]; then
  echo "Release is missing a completed Next.js build." >&2
  exit 2
fi

previous=""
if [ -L "$root/current" ]; then
  previous=$(readlink -f "$root/current")
fi

timer_was_active=false
if systemctl is-active --quiet "$health_timer"; then
  timer_was_active=true
  systemctl stop "$health_timer"
fi

restore_timer() {
  if [ "$timer_was_active" = true ]; then
    systemctl start "$health_timer"
  fi
}

trap restore_timer EXIT

activate() {
  target=$1
  ln -sfn "$target" "$root/current.next"
  chown -h arcorigin:arcorigin "$root/current.next"
  mv -Tf "$root/current.next" "$root/current"
  systemctl restart "$service_name"
}

healthy() {
  curl --fail --silent --show-error --max-time 20 "http://127.0.0.1:$port/" >/dev/null \
    && curl --fail --silent --show-error --max-time 30 "http://127.0.0.1:$port/api/health" \
      | grep -Eq '"status":"(ok|degraded)"'
}

activate "$candidate"

attempt=1
while [ "$attempt" -le 12 ]; do
  if healthy; then
    if [ -n "$previous" ] && [ "$previous" != "$candidate" ]; then
      ln -sfn "$previous" "$root/previous"
      chown -h arcorigin:arcorigin "$root/previous"
    fi
    echo "Activated $candidate"
    exit 0
  fi
  sleep 5
  attempt=$((attempt + 1))
done

if [ -n "$previous" ] && [ -d "$previous" ]; then
  echo "Release failed health checks; rolling back to $previous" >&2
  activate "$previous"
else
  echo "Release failed health checks and no previous release is available." >&2
fi

exit 1
