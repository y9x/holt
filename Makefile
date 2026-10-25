# holt — build orchestration
#
#   make build   build main/ (Vite) and run the full protection pipeline over it
#   make check   vendor sync check + typecheck + tests
#   make e2e     build, then load the compiled embed in Chrome, framed cross-site (main/scripts/embed-e2e.mjs)
#   make clean   remove build output
#
# There is no deploy target. Deployment happens via CI/CD after a push.

SHELL := /usr/bin/env bash
ROOT  := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
APP   := $(ROOT)/main

# The protection pipeline came from abulxt (VENDOR.md) and is holt's own now.
# Post-build string obfuscator: encrypts string literals and template quasis in every emitted chunk
# and the HTML shell. Runs after the build, before the canary check.
OBFUSCATE   := node "$(ROOT)/scripts/obfuscate-build.mjs"
# Canary guardrail. Hard-fails (exit 2) when a canary from scripts/canary-list.json appears in any
# scanned dir. No opt-out. main/loader is scanned too: the partner loader ships as written (it is a
# public SDK on the partner's page; see LOADER_FILE in holt-service.ts) and must stay canary-free.
CHECK       := node "$(ROOT)/scripts/check-plaintext-leaks.mjs"
# Dist reference verifier: every shipped reference resolves, emitted names are content hashes.
VERIFY_REFS := node "$(ROOT)/scripts/check-dist-refs.mjs"

.PHONY: build deps check typecheck test e2e clean

deps:
	@if [ ! -d "$(APP)/node_modules" ]; then cd "$(APP)" && npm ci; fi

build: deps
	cd "$(APP)" && npm run build
	$(OBFUSCATE) main/dist
	$(CHECK) main/dist main/loader
	$(VERIFY_REFS) main/dist

typecheck: deps
	cd "$(APP)" && npx tsc -b

test: deps
	cd "$(APP)" && npm test

check: typecheck test

e2e: build
	cd "$(APP)" && npm run e2e

clean:
	rm -rf "$(APP)/dist"
