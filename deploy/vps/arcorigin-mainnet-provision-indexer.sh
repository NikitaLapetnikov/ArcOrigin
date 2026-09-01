#!/bin/sh

set -eu

root=/opt/arcorigin-mainnet
env_file="$root/shared/.env.production"
release="${1:-$root/current}"
database_name=arcorigin_mainnet
database_user=arcorigin_indexer
unit_name=arcorigin-event-indexer.service

release=$(readlink -f "$release")
case "$release" in
  "$root"/releases/*|"$root"/current) ;;
  *) echo "Refusing release outside $root." >&2; exit 2 ;;
esac

if [ ! -f "$release/deploy/systemd/$unit_name" ]; then
  echo "Release is missing $unit_name." >&2
  exit 2
fi
if [ ! -f "$env_file" ]; then
  echo "Missing $env_file." >&2
  exit 2
fi

if ! grep -q '^DATABASE_URL=' "$env_file"; then
  database_password=$(openssl rand -hex 32)
  if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$database_user'" | grep -q 1; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER ROLE $database_user WITH LOGIN PASSWORD '$database_password'"
  else
    sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE $database_user WITH LOGIN PASSWORD '$database_password'"
  fi
  if sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$database_name'" | grep -q 1; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER DATABASE $database_name OWNER TO $database_user"
  else
    sudo -u postgres createdb --owner="$database_user" "$database_name"
  fi
  umask 077
  printf '\nDATABASE_URL=postgresql://%s:%s@127.0.0.1:5432/%s\n' \
    "$database_user" "$database_password" "$database_name" >> "$env_file"
fi

for setting in \
  'DATABASE_SSL=false' \
  'INDEXER_CONFIRMATIONS=2' \
  'INDEXER_BATCH_SIZE=1000' \
  'INDEXER_POLL_INTERVAL_MS=2000' \
  'INDEXER_ADDRESS_CHUNK_SIZE=20' \
  'INDEXER_REORG_DEPTH=64'
do
  key=${setting%%=*}
  if ! grep -q "^$key=" "$env_file"; then
    printf '%s\n' "$setting" >> "$env_file"
  fi
done

install -o root -g root -m 0644 "$release/deploy/systemd/$unit_name" "/etc/systemd/system/$unit_name"
systemctl daemon-reload
systemctl enable "$unit_name"
echo "Provisioned Postgres and $unit_name."
