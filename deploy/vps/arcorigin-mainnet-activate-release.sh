#!/bin/sh

set -eu

export ARCORIGIN_ROOT=/opt/arcorigin-mainnet
export ARCORIGIN_SERVICE=arcorigin-mainnet.service
export ARCORIGIN_HEALTH_TIMER=arcorigin-mainnet-healthcheck.timer
export ARCORIGIN_PORT=3101

exec /usr/local/sbin/arcorigin-activate-release "$@"
