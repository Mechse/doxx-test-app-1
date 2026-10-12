#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
mkdir -p .local
COPYFILE_DISABLE=1 tar -czf .local/app.tar.gz -C app app.js server.js package.json package-lock.json
# User data must fit EC2's 16 KiB decoded limit, including its base64 bundle.
size=$(wc -c < .local/app.tar.gz)
template_size=$(wc -c < infra/user_data.sh.tftpl)
if (( size * 4 / 3 + template_size + 1024 > 16384 )); then
  echo 'App bundle exceeds safe EC2 user-data size; use an artifact bucket before deploying.' >&2
  exit 1
fi
