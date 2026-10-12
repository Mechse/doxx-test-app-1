#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
test -f infra/generated.auto.tfvars.json || { echo 'Run make provision first.' >&2; exit 1; }
bash scripts/package.sh
terraform -chdir=infra init
terraform -chdir=infra plan -out=../.local/deploy.tfplan
read -r -p 'Apply this plan and create billable AWS resources? Type apply: ' answer
[[ "$answer" == apply ]] || exit 1
terraform -chdir=infra apply ../.local/deploy.tfplan
