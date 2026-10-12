#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
bash scripts/package.sh
terraform -chdir=infra init
terraform -chdir=infra plan -destroy -out=../.local/destroy.tfplan
read -r -p 'Permanently delete this demo and its notes? Type destroy: ' answer
[[ "$answer" == destroy ]] || exit 1
terraform -chdir=infra apply ../.local/destroy.tfplan
bash scripts/doxx-teardown.sh
