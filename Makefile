SHELL := /bin/bash
.DEFAULT_GOAL := help
.PHONY: help install test validate check servers tunnels provision deploy verify verify-offline latency report destroy https login
help:
	@echo 'Local: install test validate | Live: check servers tunnels provision deploy verify verify-offline latency report destroy'
install:
	npm --prefix app ci --ignore-scripts
test:
	npm --prefix app test
validate:
	bash scripts/package.sh
	terraform -chdir=infra fmt -check
	terraform -chdir=infra validate
	@for script in scripts/*.sh; do bash -n "$$script" || exit; done
check:
	bash scripts/check.sh
servers:
	node --env-file-if-exists=.env scripts/doxx.mjs servers
tunnels:
	node --env-file-if-exists=.env scripts/doxx.mjs tunnels
provision:
	bash scripts/doxx-provision.sh
deploy:
	bash scripts/deploy.sh
verify:
	bash scripts/verify.sh
verify-offline:
	bash scripts/verify.sh --offline
latency:
	node --env-file-if-exists=.env --test --test-concurrency=1 tests/latency/*.test.mjs
report:
	node scripts/latency-report.mjs
destroy:
	bash scripts/destroy.sh
https login:
	@echo 'Deferred to the separately planned HTTPS and login stages.' >&2
	@exit 1
.PHONY: security-check
security-check:
	node --env-file-if-exists=.env scripts/security-check.mjs
.PHONY: test-infra
test-infra:
	bash scripts/package.sh
	terraform -chdir=infra test
