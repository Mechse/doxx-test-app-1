#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
exec node --env-file-if-exists=.env scripts/doxx.mjs teardown
