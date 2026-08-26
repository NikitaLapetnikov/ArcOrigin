#!/bin/sh

set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: arcorigin-activate-release /opt/arcorigin/releases/<release>" >&2
  exit 2
fi

candidate=$(readlink -f "$1")
case "$candidate" in
  /opt/arcorigin/releases/*) ;;
  *)
    echo "Refusing release outside /opt/arcorigin/releases." >&2
    exit 2
    ;;
esac

if [ ! -f "$candidate/.next/BUILD_ID" ] || [ ! -x "$candidate/node_modules/.bin/next" ]; then
  echo "Release is missing a completed Next.js build." >&2
  exit 2
fi

previous=""
if [ -L /opt/arcorigin/current ]; then
  previous=$(readlink -f /opt/arcorigin/current)
fi

timer_was_active=false
if systemctl is-active --quiet arcorigin-healthcheck.timer; then
  timer_was_active=true
  systemctl stop arcorigin-healthcheck.timer
fi

restore_timer() {
  if [ "$timer_was_active" = true ]; then
    systemctl start arcorigin-healthcheck.timer
  fi
}

trap restore_timer EXIT

activate() {
  target=$1
  ln -sfn "$target" /opt/arcorigin/current.next
  chown -h arcorigin:arcorigin /opt/arcorigin/current.next
  mv -Tf /opt/arcorigin/current.next /opt/arcorigin/current
  systemctl restart arcorigin.service
}

healthy() {
  curl --fail --silent --show-error --max-time 20 http://127.0.0.1:3100/ >/dev/null \
    && curl --fail --silent --show-error --max-time 30 http://127.0.0.1:3100/api/health \
      | grep -Eq '"status":"(ok|degraded)"'
}

activate "$candidate"

attempt=1
while [ "$attempt" -le 12 ]; do
  if healthy; then
    if [ -n "$previous" ] && [ "$previous" != "$candidate" ]; then
      ln -sfn "$previous" /opt/arcorigin/previous
      chown -h arcorigin:arcorigin /opt/arcorigin/previous
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
