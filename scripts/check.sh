#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
for tool in aws terraform wg jq node npm curl tar; do command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }; done
node --env-file-if-exists=.env --input-type=module <<'JS'
if (+process.versions.node.split('.')[0] < 22) throw new Error('Node 22 or 24 required');
for (const key of ['DOXX_TOKEN', 'DOXX_SERVER', 'DEVICE_TUNNEL_NAME']) if (!process.env[key]) throw new Error(`Set ${key} in .env`);
JS
aws sts get-caller-identity --query Account --output text >/dev/null
echo 'Tools and AWS credentials are available. No resources were changed.'
